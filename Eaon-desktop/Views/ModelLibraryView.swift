import AppKit
import SwiftUI

/// The "Models" section: download open models from Ollama's library or
/// Hugging Face right here, watch the progress, then chat with them — all
/// running privately on this Mac.
struct ModelLibraryView: View {
    @Environment(\.themeColors) private var colors
    @Environment(\.openWindow) private var openWindow
    @Bindable var chatViewModel: ChatViewModel
    @Bindable private var manager = LocalAIManager.shared
    /// Called with a local model id when the user hits "Chat".
    var onStartChat: (String) -> Void

    private enum LibrarySource: String, CaseIterable {
        case ollama = "Ollama"
        case huggingFace = "Hugging Face"
    }

    @State private var source: LibrarySource = .ollama
    @State private var searchText = ""
    /// GGUF (llama.cpp) or MLX — MLX is Apple's own framework and often runs
    /// faster than GGUF on Apple Silicon specifically, but until now had no
    /// discovery UI at all (only a manual "paste a repo id" entry point in
    /// Settings), unlike GGUF's full search-and-download experience here.
    @State private var hfFormat: LocalAIManager.HFModelFormat = .gguf
    @State private var hfResults: [LocalAIManager.HFSearchResult] = []
    @State private var isSearchingHF = false
    @State private var searchTask: Task<Void, Never>?
    @State private var recordPendingDeletion: LocalModelRecord?
    /// Non-nil when a delete VERIFIABLY failed (Ollama refused / file
    /// still on disk) — shown as an alert, because silently pretending
    /// the space was freed is the bug this exists to prevent.
    @State private var deletionFailureMessage: String?
    /// Which Ollama categories are expanded — "Popular" open by default, the
    /// rest collapsed so 100+ models don't read as one giant wall.
    @State private var expandedCategories: Set<String> = ["Popular"]
    /// Real download sizes for the current Hugging Face search results,
    /// fetched after the search completes so a "will this fit" badge can be
    /// shown before the user commits to downloading — keyed by repo id.
    @State private var hfSizes: [String: Int64] = [:]
    @State private var hfSizesFetching: Set<String> = []
    /// Whether `hfResults` currently holds the default trending list rather
    /// than a typed search's results — drives the section heading and
    /// re-fetch-on-clear behavior.
    @State private var isShowingTrending = false
    @State private var isLoadingTrending = false
    /// Same idea, for whatever exact name the user typed into the Ollama
    /// search bar that isn't part of the curated list.
    @State private var customPullSize: Int64?
    @State private var isCheckingCustomPullSize = false
    /// Which HF repo cards have their variant (quantization) list expanded
    /// inline, and the lazily-fetched options per repo (fetched once, cached
    /// here). "Show variants" reveals every real quantization the repo
    /// publishes, each with its own size, fit check, and download.
    @State private var expandedHFRepos: Set<String> = []
    @State private var ggufOptions: [String: [LocalAIManager.GGUFFile]] = [:]
    /// The auto-picked default quant label per repo (e.g. "Q4_K_M"),
    /// captured during size prefetch so the collapsed card's one-click
    /// download button can name exactly which file it'll fetch.
    @State private var hfDefaultQuant: [String: String] = [:]
    /// A quant picker row (or the plain one-click download button) tapped
    /// while its own real fit estimate is `.tooBig` — held here so an alert
    /// can confirm before actually starting the download, rather than
    /// downloading tens of gigabytes on the first tap with no warning.
    @State private var pendingTooBigDownload: (repo: String, file: LocalAIManager.GGUFFile?)?
    /// Real params/quantization/family for curated + custom-pull Ollama
    /// entries, keyed by model name — fetched lazily from Ollama's public
    /// registry (see `LocalAIManager.fetchOllamaRegistrySpecs`) rather than
    /// baked into the curated JSON, so it never goes stale. Fetched once a
    /// category is expanded (or immediately for "Popular", open by default)
    /// rather than for all 124 curated models up front.
    @State private var ollamaSpecs: [String: LocalAIManager.OllamaModelSpecs] = [:]
    @State private var ollamaSpecsFetching: Set<String> = []
    /// Opens `LocalBackendsInstallSheet` — every local runner's install
    /// command in one place, reachable proactively from the header (not
    /// only after hitting a "this isn't installed" wall on one specific tab).
    @State private var showingInstallGuide = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    sourceAndSearchBar

                    switch source {
                    case .ollama: ollamaLibrary
                    case .huggingFace: huggingFaceLibrary
                    }

                    onThisMacSection
                }
                .padding(.horizontal, 32)
                .padding(.bottom, 32)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(colors.backgroundPrimary)
        .onAppear {
            // Everything here is deferred off the first paint. This used to
            // run inline, so opening the page did a synchronous PATH sweep
            // for every backend AND kicked off 28 registry requests before
            // SwiftUI had drawn a single frame — the sidebar button stayed
            // visually held down the whole time, because the main actor was
            // busy and never got to render the released state.
            //
            // A yield is enough: the view paints, THEN the work starts.
            Task {
                await Task.yield()
                // Thorough check (see `refreshInstalledBackends`) — this page
                // shows install state too, and its login-shell pass is both
                // throttled and off the main actor, so it doesn't reintroduce
                // the first-paint stall described above.
                await manager.refreshInstalledBackends()
                await manager.refreshOllamaModels(startServerIfNeeded: true)
            }
            Task {
                await Task.yield()
                prefetchOllamaSpecs(for: LocalAIManager.curatedOllamaModels
                    .filter { $0.category == "Popular" }
                    .map(\.name))
            }
        }
        .alert(
            "Delete this model?",
            isPresented: Binding(
                get: { recordPendingDeletion != nil },
                set: { if !$0 { recordPendingDeletion = nil } }
            ),
            presenting: recordPendingDeletion
        ) { record in
            Button("Delete", role: .destructive) {
                deleteRecord(record)
                recordPendingDeletion = nil
            }
            Button("Cancel", role: .cancel) { recordPendingDeletion = nil }
        } message: { record in
            Text(record.backend == .ollama
                 ? "\(record.displayName) will be removed from this Mac (frees \(record.detail.replacingOccurrences(of: " on this Mac", with: ""))). You can download it again anytime."
                 : "\(record.displayName) will be removed. Downloaded files in the app's models folder are deleted too.")
        }
        .sheet(isPresented: $showingInstallGuide) {
            LocalBackendsInstallSheet()
        }
        .alert(
            "Couldn't delete the model",
            isPresented: Binding(
                get: { deletionFailureMessage != nil },
                set: { if !$0 { deletionFailureMessage = nil } }
            )
        ) {
            Button("OK") { deletionFailureMessage = nil }
        } message: {
            Text(deletionFailureMessage ?? "")
        }
    }

    // MARK: Model page links

    /// Ollama's library pages are keyed by the base model name only — any
    /// `:tag` is a size/quant variant picked *within* the page, not part of
    /// its URL. Opens as a real pop-up app window (the `WindowGroup(for:
    /// URL.self)` scene in `App.swift`), not the system browser — reopening
    /// the same URL brings that window forward instead of duplicating it.
    private func openOllamaLibraryPage(for name: String) {
        let base = String(name.split(separator: ":", maxSplits: 1).first ?? Substring(name))
        guard let url = URL(string: "https://ollama.com/library/\(base)") else { return }
        openWindow(value: url)
    }

    private func openHuggingFacePage(for repo: String) {
        guard let url = URL(string: "https://huggingface.co/\(repo)") else { return }
        openWindow(value: url)
    }

    // A featured card for PrismML's Bonsai 27B lived here briefly
    // (2026-07-14). Removed the same day: downloading it works (verified —
    // the file transfers byte-perfect), but loading it does NOT — its
    // ternary/1-bit quantization uses a ggml tensor type (42) that this
    // Mac's installed llama.cpp (Homebrew, build b9050) doesn't recognize
    // yet ("invalid ggml type 42, should be in [0, 42)" — confirmed by
    // loading the exact downloaded file directly with `llama-server`,
    // bypassing the app entirely, to rule out an app-side bug first).
    // PrismML ships a separate, non-Ollama/non-llama.cpp runtime
    // specifically because of this — this app has no such runtime, and
    // adding a "download" shortcut for a model that can't actually run
    // once downloaded is the exact "UI promises something that doesn't
    // happen" bug this app has been burned by before. Worth re-adding once
    // ggml/llama.cpp upstream supports this quantization (or if this app
    // ever integrates PrismML's own runtime) — re-verify from scratch at
    // that point rather than assuming this note is still accurate.

    // MARK: Header

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Models")
                    .font(AppFont.mono(20, weight: .bold))
                    .foregroundColor(colors.textPrimary)
                Text("Download open models and run them privately on this Mac. No API key, and no internet once they're here.")
                    .font(AppFont.sans(12))
                    .foregroundColor(colors.textSecondary)
            }

            Spacer(minLength: 12)

            Button {
                showingInstallGuide = true
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "terminal")
                        .font(.system(size: 11))
                        .iconHoverEffect(for: "terminal")
                    Text("Install Local Runners")
                        .font(AppFont.mono(11, weight: .medium))
                }
            }
            .buttonStyle(.bordered)
            .help("See install commands for Ollama, llama.cpp, and MLX")
        }
        .padding(.horizontal, 32)
        .padding(.top, 50)
        .padding(.bottom, 18)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Source picker + search

    private var sourceAndSearchBar: some View {
        HStack(spacing: 10) {
            HStack(spacing: 2) {
                ForEach(LibrarySource.allCases, id: \.self) { candidate in
                    Button {
                        source = candidate
                        runSearchIfNeeded()
                    } label: {
                        Text(candidate.rawValue)
                            .font(AppFont.mono(12, weight: .medium))
                            .foregroundStyle(source == candidate ? colors.textPrimary : colors.textSecondary)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(Capsule().fill(source == candidate ? colors.backgroundSelected : .clear))
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(2)
            .background(Capsule().fill(colors.backgroundChip))

            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 12))
                    .foregroundStyle(colors.textTertiary)
                TextField(
                    source == .ollama ? "Any name from ollama.com/library…" : "Search Hugging Face…",
                    text: $searchText
                )
                .textFieldStyle(.plain)
                .font(AppFont.mono(13))
                .onChange(of: searchText) { _, _ in runSearchIfNeeded() }
                if isSearchingHF {
                    ProgressView().controlSize(.small)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(colors.backgroundInput)
            .clipShape(Capsule())
            .overlay(Capsule().stroke(colors.borderSubtle, lineWidth: 1))
        }
    }

    private func runSearchIfNeeded() {
        searchTask?.cancel()
        guard source == .huggingFace else { return }
        let query = searchText.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else {
            loadTrendingIfNeeded()
            return
        }
        isShowingTrending = false
        searchTask = Task {
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard !Task.isCancelled else { return }
            isSearchingHF = true
            let results = await manager.searchHuggingFace(query, format: hfFormat)
            guard !Task.isCancelled else { return }
            hfResults = results
            isSearchingHF = false
            await prefetchHFSizes(for: results)
        }
    }

    /// Loads the default "Trending on Hugging Face" list — real, live,
    /// most-downloaded models in the current format — so the tab has
    /// something to browse the moment you open it, not just a search box
    /// waiting for input.
    private func loadTrendingIfNeeded() {
        guard !isShowingTrending, !isLoadingTrending else { return }
        isShowingTrending = true
        isLoadingTrending = true
        searchTask?.cancel()
        searchTask = Task {
            let results = await manager.searchHuggingFace("", format: hfFormat, limit: 20)
            guard !Task.isCancelled else { return }
            hfResults = results
            isLoadingTrending = false
            await prefetchHFSizes(for: results)
        }
    }

    /// Switching formats is a fresh browse, not a filter over what's already
    /// showing — GGUF and MLX search hit different Hugging Face result sets
    /// entirely.
    private func switchFormat(to format: LocalAIManager.HFModelFormat) {
        guard format != hfFormat else { return }
        hfFormat = format
        hfResults = []
        isShowingTrending = false
        runSearchIfNeeded()
    }

    /// Resolves each search result's real download size concurrently, so a
    /// fit badge can appear before the user commits — GGUF resolves its one
    /// auto-picked file the same way `startHFDownload` does later; MLX sums
    /// the repo's real safetensors weights, since there's no single file to
    /// point at.
    private func prefetchHFSizes(for results: [LocalAIManager.HFSearchResult]) async {
        hfSizes.removeAll()
        hfDefaultQuant.removeAll()
        expandedHFRepos.removeAll()
        hfSizesFetching = Set(results.map(\.id))
        let format = hfFormat
        await withTaskGroup(of: (id: String, size: Int64?, quant: String?).self) { group in
            for result in results {
                group.addTask {
                    switch format {
                    case .gguf:
                        // Resolve the same auto-picked file `startHFDownload`
                        // would fetch, and derive its quant label so the
                        // collapsed card can name it ("Download · Q4_K_M").
                        let file = try? await manager.resolveGGUFFile(repo: result.id)
                        let quant = file.map { LocalAIManager.GGUFFile(path: $0.path, size: $0.size).quantLabel }
                        return (result.id, file?.size, (quant?.isEmpty == false) ? quant : nil)
                    case .mlx:
                        let size = try? await manager.resolveMLXRepoSize(repo: result.id)
                        return (result.id, size, nil)
                    }
                }
            }
            for await (id, size, quant) in group {
                guard !Task.isCancelled else { return }
                if let size, size > 0 { hfSizes[id] = size }
                if let quant { hfDefaultQuant[id] = quant }
                hfSizesFetching.remove(id)
            }
        }
    }

    /// Lazily fetches real params/quantization/family for names that aren't
    /// cached (or already in flight) yet — called when "Popular" first
    /// appears and whenever another category is expanded, so specs load
    /// progressively instead of all 124 models' worth up front.
    ///
    /// Fetches concurrently via a task group and merges the results into
    /// `ollamaSpecs` in ONE state write, not one per model — the previous
    /// version fired an independent `Task` per name, each mutating
    /// `ollamaSpecs`/`ollamaSpecsFetching` the instant its own request
    /// landed. With 14 models in "Popular" alone, that's 14 separate
    /// SwiftUI re-renders of the whole card (each re-running
    /// `groupedCuratedModels`'s grouping pass) firing in a ragged burst as
    /// responses trickle in — this was the actual, measurable "the page
    /// lags when I open it" cause, not the network calls themselves.
    /// Mirrors `prefetchHFSizes`'s already-correct batching pattern below.
    private func prefetchOllamaSpecs(for names: [String]) {
        let pending = names.filter { ollamaSpecs[$0] == nil && !ollamaSpecsFetching.contains($0) }
        guard !pending.isEmpty else { return }
        ollamaSpecsFetching.formUnion(pending)
        Task {
            let fetched = await withTaskGroup(of: (String, LocalAIManager.OllamaModelSpecs?).self) { group in
                for name in pending {
                    group.addTask { (name, await manager.fetchOllamaRegistrySpecs(name: name)) }
                }
                var results: [String: LocalAIManager.OllamaModelSpecs] = [:]
                for await (name, specs) in group {
                    if let specs { results[name] = specs }
                }
                return results
            }
            ollamaSpecsFetching.subtract(pending)
            ollamaSpecs.merge(fetched) { _, new in new }
        }
    }

    /// Real facts (params, quant, family, context) as individual chips
    /// instead of one dot-joined "3.2B · Q4_K_M · llama" line — a terminal-
    /// readout look (small monospace tags) reads as more information-dense
    /// and technical than a single gray caption, and each fact stays
    /// independently scannable instead of running together. Only the parts
    /// that are actually known are returned — an empty array when nothing
    /// is known yet, so callers can cleanly skip rendering anything.
    private static func specChips(paramSize: String?, quantization: String?, family: String?, contextLength: Int? = nil) -> [String] {
        var parts: [String] = []
        if let paramSize { parts.append(paramSize) }
        if let quantization { parts.append(quantization) }
        if let family { parts.append(family) }
        if let contextLength, contextLength > 0 {
            parts.append(contextLength >= 1000 ? "\(contextLength / 1000)K ctx" : "\(contextLength) ctx")
        }
        return parts
    }

    /// A compact byte count in the same style as the rest of the page's
    /// GB readouts — used for the aggregate "Σ size" stat on category
    /// headers, a small but genuinely nerdy touch (real total, not a
    /// vibes estimate).
    private static func formatBytes(_ bytes: Int64) -> String {
        let gb = Double(bytes) / 1_000_000_000
        return gb >= 100 ? String(format: "%.0f GB", gb) : String(format: "%.1f GB", gb)
    }

    // MARK: Ollama library

    private var ollamaQuery: String { searchText.trimmingCharacters(in: .whitespaces).lowercased() }

    private func matches(_ model: LocalAIManager.CuratedOllamaModel, query: String) -> Bool {
        guard !query.isEmpty else { return true }
        return model.name.lowercased().contains(query)
            || model.blurb.lowercased().contains(query)
            || model.category.lowercased().contains(query)
    }

    /// Curated models grouped by category, in display order, filtered to
    /// whatever matches the search text — a category with zero matches while
    /// searching simply doesn't appear.
    private var groupedCuratedModels: [(category: String, models: [LocalAIManager.CuratedOllamaModel])] {
        let query = ollamaQuery
        let grouped = Dictionary(grouping: LocalAIManager.curatedOllamaModels) { $0.category }
        return LocalAIManager.curatedCategoryOrder.compactMap { category in
            guard let models = grouped[category] else { return nil }
            let filtered = query.isEmpty ? models : models.filter { matches($0, query: query) }
            guard !filtered.isEmpty else { return nil }
            return (category, filtered)
        }
    }

    @ViewBuilder
    private var ollamaLibrary: some View {
        if !manager.installed.contains(.ollama) {
            missingBackendCard(.ollama)
        } else {
            let query = searchText.trimmingCharacters(in: .whitespaces)
            if !query.isEmpty, !LocalAIManager.curatedOllamaModels.contains(where: { $0.name == query }) {
                customPullRow(query)
            }

            ForEach(groupedCuratedModels, id: \.category) { group in
                categorySection(group.category, models: group.models)
            }

            Text("\(LocalAIManager.curatedOllamaModels.count) open models across every major maker. Type any other ollama.com/library name above to download it directly.")
                .font(AppFont.sans(11))
                .foregroundColor(colors.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)
        }
    }

    private func categorySection(_ category: String, models: [LocalAIManager.CuratedOllamaModel]) -> some View {
        // While actively searching, every matching category stays expanded
        // (and can't be collapsed) so filtered results are never hidden.
        let isSearching = !ollamaQuery.isEmpty
        let isExpanded = isSearching || expandedCategories.contains(category)

        return VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(.easeOut(duration: 0.15)) {
                    if expandedCategories.contains(category) {
                        expandedCategories.remove(category)
                    } else {
                        expandedCategories.insert(category)
                        prefetchOllamaSpecs(for: models.map(\.name))
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    Text(category)
                        .font(AppFont.mono(13, weight: .semibold))
                        .foregroundColor(colors.textPrimary)
                    Text("\(models.count)")
                        .font(AppFont.mono(11))
                        .foregroundColor(colors.textTertiary)
                    // A real computed total, not a vibe — how much disk
                    // this whole category would cost if you downloaded
                    // every model in it.
                    Text("Σ \(Self.formatBytes(models.reduce(0) { $0 + $1.sizeBytes }))")
                        .font(AppFont.mono(10.5))
                        .foregroundColor(colors.textTertiary)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(colors.textTertiary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .iconHoverEffect(for: "chevron.right")
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(isSearching)

            if isExpanded {
                SettingsCard {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(models.enumerated()), id: \.element.id) { index, model in
                            if index > 0 { Divider().padding(.leading, 16) }
                            curatedRow(model)
                        }
                    }
                }
            }
        }
    }

    private func customPullRow(_ name: String) -> some View {
        SettingsCard {
            HStack(spacing: 12) {
                ModelOriginBadge(brand: LocalAIManager.guessBrand(forName: name))
                Button {
                    openOllamaLibraryPage(for: name)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(name)
                            .font(AppFont.mono(13, weight: .semibold))
                            .foregroundColor(colors.textPrimary)
                        HStack(spacing: 8) {
                            if manager.pullingModelName == name, let fraction = manager.pullFraction {
                                ProgressView(value: fraction)
                                    .controlSize(.small)
                                    .frame(width: 100)
                            }
                            Text(pullStatusText(for: name) ?? "From ollama.com/library")
                                .font(AppFont.mono(11))
                                .foregroundColor(colors.textTertiary)
                                .lineLimit(1)
                        }
                        if pullStatusText(for: name) == nil, let specs = ollamaSpecs[name] {
                            SpecChipRow(chips: Self.specChips(paramSize: specs.paramSize, quantization: specs.quantization, family: specs.family))
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("See \(name)'s full description, benchmarks, and license on ollama.com")
                Spacer()
                if manager.pullingModelName != name {
                    if let size = customPullSize {
                        ModelFitBadge(estimate: ModelFitEstimator.assess(downloadSizeBytes: size, backend: .ollama))
                    } else if isCheckingCustomPullSize {
                        ModelFitLoadingBadge()
                    }
                }
                ollamaActionButton(name: name)
            }
            .padding(14)
        }
        .task(id: name) {
            customPullSize = nil
            isCheckingCustomPullSize = true
            // Debounce so a fetch doesn't fire on every keystroke.
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled else { return }
            async let size = manager.fetchOllamaRegistrySize(name: name)
            async let specs = manager.fetchOllamaRegistrySpecs(name: name)
            let (resolvedSize, resolvedSpecs) = await (size, specs)
            guard !Task.isCancelled else { return }
            customPullSize = resolvedSize
            if let resolvedSpecs { ollamaSpecs[name] = resolvedSpecs }
            isCheckingCustomPullSize = false
        }
    }

    private func curatedRow(_ model: LocalAIManager.CuratedOllamaModel) -> some View {
        HStack(spacing: 12) {
            ModelOriginBadge(brand: model.brand)
            Button {
                openOllamaLibraryPage(for: model.name)
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Text(model.name)
                            .font(AppFont.mono(13, weight: .semibold))
                            .foregroundColor(colors.textPrimary)
                        if model.isNew {
                            NewModelBadge()
                        }
                        Text(model.approxSize)
                            .font(AppFont.mono(10.5))
                            .foregroundColor(colors.textTertiary)
                    }
                    HStack(spacing: 8) {
                        if manager.pullingModelName == model.name, let fraction = manager.pullFraction {
                            ProgressView(value: fraction)
                                .controlSize(.small)
                                .frame(width: 100)
                        }
                        Text(pullStatusText(for: model.name) ?? model.blurb)
                            .font(AppFont.mono(11))
                            .foregroundColor(colors.textSecondary)
                            .lineLimit(1)
                    }
                    if pullStatusText(for: model.name) == nil, let specs = ollamaSpecs[model.name] {
                        SpecChipRow(chips: Self.specChips(paramSize: specs.paramSize, quantization: specs.quantization, family: specs.family))
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("See \(model.name)'s full description, benchmarks, and license on ollama.com")
            Spacer(minLength: 12)
            if manager.installedOllamaModelId(model.name) == nil, manager.pullingModelName != model.name {
                ModelFitBadge(estimate: ModelFitEstimator.assess(downloadSizeBytes: model.sizeBytes, backend: .ollama))
                Button {
                    // Base name only (before any :tag) — types the family
                    // name into search so the user can add their own
                    // quantization/size tag and get the same live size
                    // verification the free-text custom-pull row already
                    // does, rather than guessing which tags this particular
                    // model actually publishes.
                    searchText = String(model.name.split(separator: ":", maxSplits: 1).first ?? Substring(model.name))
                }
                label: {
                    Image(systemName: "slider.horizontal.3")
                        .font(.system(size: 11))
                        .foregroundColor(colors.textSecondary)
                        .iconHoverEffect(for: "slider.horizontal.3")
                        .frame(width: 26, height: 26)
                        .background(Circle().stroke(colors.borderMedium, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .help("Choose a different size or quantization")
            }
            ollamaActionButton(name: model.name)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
    }

    private func pullStatusText(for name: String) -> String? {
        guard manager.pullingModelName == name else { return nil }
        return manager.pullStatus
    }

    @ViewBuilder
    private func ollamaActionButton(name: String) -> some View {
        if let installedId = manager.installedOllamaModelId(name) {
            chatButton(modelId: installedId)
        } else if manager.pullingModelName == name {
            ProgressView().controlSize(.small)
        } else {
            downloadButton(disabled: manager.isPulling) {
                Task {
                    await manager.pullOllamaModel(name)
                    // Same one-click "download it and take me to chat"
                    // hand-off as the Hugging Face path — no separate
                    // "Chat" click to notice and make.
                    if let modelId = manager.installedOllamaModelId(name) {
                        onStartChat(modelId)
                    }
                }
            }
        }
    }

    // MARK: Hugging Face library

    @ViewBuilder
    private var huggingFaceLibrary: some View {
        VStack(alignment: .leading, spacing: 12) {
            formatToggle

            if !manager.installed.contains(hfFormat.backend) {
                missingBackendCard(hfFormat.backend)
            } else if isLoadingTrending {
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text("Loading popular models from Hugging Face…")
                        .font(AppFont.mono(13))
                        .foregroundColor(colors.textSecondary)
                }
            } else if hfResults.isEmpty && !isSearchingHF && !isShowingTrending {
                Text("No \(hfFormat.displayName) models matched. Try different words.")
                    .font(AppFont.mono(13))
                    .foregroundColor(colors.textSecondary)
            } else if !hfResults.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text(isShowingTrending ? "Trending on Hugging Face" : "Search results")
                        .font(AppFont.mono(13, weight: .semibold))
                        .foregroundColor(colors.textPrimary)

                    // One card per model (like the reference), not a single
                    // divided list — each card can expand its own variants.
                    LazyVStack(spacing: 12) {
                        ForEach(hfResults) { result in
                            hfModelCard(result)
                        }
                    }

                    Text(hfFormat == .gguf
                         ? "Hugging Face hosts hundreds of thousands of models, so search above for anything specific. Each card downloads the best single-file (GGUF) version by default. Open “Show variants” to pick a specific quantization."
                         : "Hugging Face hosts hundreds of thousands of models, so search above for anything specific. MLX is Apple's own framework and often runs faster than GGUF here. Models download automatically the first time you chat with them.")
                        .font(AppFont.sans(11))
                        .foregroundColor(colors.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineSpacing(3)
                }
            }
        }
    }

    /// GGUF/MLX — same visual language as the Ollama/Hugging Face source
    /// picker just above it, one level down.
    private var formatToggle: some View {
        HStack(spacing: 2) {
            ForEach(LocalAIManager.HFModelFormat.allCases, id: \.self) { candidate in
                Button {
                    switchFormat(to: candidate)
                } label: {
                    Text(candidate.displayName)
                        .font(AppFont.mono(11, weight: .medium))
                        .foregroundStyle(hfFormat == candidate ? colors.textPrimary : colors.textSecondary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(Capsule().fill(hfFormat == candidate ? colors.backgroundSelected : .clear))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background(Capsule().fill(colors.backgroundChip))
    }

    /// One Hugging Face model, as a card: name + size/fit + default-download
    /// at the top, an author/stats line beneath, and (GGUF only) a
    /// "Show variants" toggle that expands the full quantization list inline.
    private func hfModelCard(_ result: LocalAIManager.HFSearchResult) -> some View {
        let repo = result.id
        let parts = repo.split(separator: "/", maxSplits: 1).map(String.init)
        let author = parts.count > 1 ? parts[0] : nil
        let name = parts.count > 1 ? parts[1] : repo
        let isExpanded = expandedHFRepos.contains(repo)

        return VStack(alignment: .leading, spacing: 12) {
            // Header: name (left) · size + fit + action (right).
            HStack(alignment: .top, spacing: 12) {
                Button { openHuggingFacePage(for: repo) } label: {
                    Text(name)
                        .font(AppFont.mono(15, weight: .semibold))
                        .foregroundColor(colors.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("See \(repo)'s model card on huggingface.co")

                Spacer(minLength: 12)

                VStack(alignment: .trailing, spacing: 8) {
                    if manager.downloadedModelId(forRepo: repo) == nil, manager.hfDownloads[repo] == nil {
                        HStack(spacing: 8) {
                            if let size = hfSizes[repo] {
                                Text(String(format: "%.1f GB", Double(size) / 1_000_000_000))
                                    .font(AppFont.mono(12, weight: .medium))
                                    .foregroundColor(colors.textSecondary)
                                ModelFitBadge(estimate: ModelFitEstimator.assess(downloadSizeBytes: size, backend: hfFormat.backend))
                            } else if hfSizesFetching.contains(repo) {
                                ModelFitLoadingBadge()
                            }
                        }
                    }
                    hfPrimaryAction(repo: repo, name: name)
                }
            }

            // Author + real stats (downloads / likes) on the left; the
            // variants toggle on the right (GGUF only — MLX quants are
            // separate repos, so there's nothing to expand).
            HStack(spacing: 14) {
                if let author {
                    Text("By \(author)")
                        .font(AppFont.mono(11))
                        .foregroundColor(colors.textSecondary)
                }
                statChip(icon: "arrow.down.circle", text: Self.formatCount(result.downloads))
                statChip(icon: "heart", text: Self.formatCount(result.likes))

                Spacer(minLength: 8)

                if hfFormat == .gguf {
                    Button {
                        toggleHFVariants(repo)
                    } label: {
                        HStack(spacing: 5) {
                            Text("Show variants")
                                .font(AppFont.mono(11, weight: .medium))
                            Image(systemName: "chevron.down")
                                .font(.system(size: 9, weight: .semibold))
                                .rotationEffect(.degrees(isExpanded ? 180 : 0))
                                .iconHoverEffect(for: "chevron.down")
                        }
                        .foregroundColor(colors.textSecondary)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("List every quantization this model publishes")
                }
            }

            if isExpanded {
                Divider().overlay(colors.borderSubtle)
                hfVariantsList(repo: repo)
            }
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(colors.backgroundElevated)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(colors.borderSubtle, lineWidth: 1)
        )
        .alert(
            "This probably won't run comfortably",
            isPresented: Binding(
                get: { pendingTooBigDownload?.repo == repo },
                set: { if !$0 { pendingTooBigDownload = nil } }
            )
        ) {
            Button("Cancel", role: .cancel) { pendingTooBigDownload = nil }
            Button("Download anyway", role: .destructive) {
                guard let pending = pendingTooBigDownload else { return }
                pendingTooBigDownload = nil
                if pending.file == nil, manager.hfDownloads[pending.repo]?.failed == true {
                    manager.clearHFDownloadState(repo: pending.repo)
                }
                manager.startHFDownload(repo: pending.repo, file: pending.file) { modelId in
                    if let modelId { onStartChat(modelId) }
                }
            }
        } message: {
            if let size = pendingTooBigDownload?.file?.size ?? hfSizes[repo] {
                Text(ModelFitEstimator.assess(downloadSizeBytes: size, backend: hfFormat.backend).detail)
            }
        }
    }

    /// The card's top-right action — reflects real state: chat when it's
    /// already downloaded, progress + cancel mid-download, retry after a
    /// failure, else a one-click "Download · <quant>" for the auto-picked
    /// default file.
    @ViewBuilder
    private func hfPrimaryAction(repo: String, name: String) -> some View {
        let download = manager.hfDownloads[repo]
        if let downloadedId = manager.downloadedModelId(forRepo: repo) {
            chatButton(modelId: downloadedId)
        } else if let download, !download.failed {
            HStack(spacing: 8) {
                if let fraction = download.fraction, !download.finished {
                    ProgressView(value: fraction).controlSize(.small).frame(width: 90)
                } else {
                    ProgressView().controlSize(.small)
                }
                Button { manager.cancelHFDownload(repo: repo) } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(colors.textTertiary)
                        .iconHoverEffect(for: "xmark.circle.fill")
                }
                .buttonStyle(.plain)
                .help("Cancel download")
            }
        } else if hfFormat == .mlx {
            // MLX has no in-app download to track — `addUserModel` registers
            // it, then the same one-click "land in chat" hand-off kicks off
            // the real (lazy, mlx_lm.server-driven) download.
            hfDownloadPill(label: "Download") {
                manager.addUserModel(backend: .mlx, source: repo, isFile: false)
                if let modelId = manager.downloadedModelId(forRepo: repo) { onStartChat(modelId) }
            }
        } else {
            let quantSuffix = hfDefaultQuant[repo].map { " · \($0)" } ?? ""
            hfDownloadPill(label: "Download\(quantSuffix)", failed: download?.failed == true) {
                if let size = hfSizes[repo], ModelFitEstimator.assess(downloadSizeBytes: size, backend: hfFormat.backend).verdict == .tooBig {
                    pendingTooBigDownload = (repo, nil)
                    return
                }
                if download?.failed == true { manager.clearHFDownloadState(repo: repo) }
                manager.startHFDownload(repo: repo) { modelId in
                    if let modelId { onStartChat(modelId) }
                }
            }
        }
    }

    private func hfDownloadPill(label: String, failed: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: failed ? "arrow.clockwise" : "arrow.down.circle")
                    .font(.system(size: 11))
                    .iconHoverEffect(for: failed ? "arrow.clockwise" : "arrow.down.circle")
                Text(failed ? "Retry" : label)
                    .font(AppFont.mono(12, weight: .medium))
            }
            .foregroundStyle(colors.textPrimary)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Capsule().stroke(colors.borderMedium, lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(PressableButtonStyle())
    }

    private func statChip(icon: String, text: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(.system(size: 10))
            Text(text)
                .font(AppFont.mono(11))
        }
        .foregroundColor(colors.textTertiary)
    }

    private func toggleHFVariants(_ repo: String) {
        withAnimation(.easeOut(duration: 0.15)) {
            if expandedHFRepos.contains(repo) {
                expandedHFRepos.remove(repo)
            } else {
                expandedHFRepos.insert(repo)
            }
        }
    }

    /// The inline variant list revealed by "Show variants" — every real
    /// quantization the repo publishes (smallest first), each with its own
    /// size class, fit check, size, and a one-click download. Fetched once
    /// per repo and cached in `ggufOptions`.
    ///
    /// Each row runs its OWN `ModelFitEstimator.assess` against that file's
    /// real size, and a `.tooBig` pick confirms via the card's alert instead
    /// of downloading tens of GB on the first tap — the exact gap a user hit
    /// downloading deepseek-v4-flash's largest quant with zero warning.
    @ViewBuilder
    private func hfVariantsList(repo: String) -> some View {
        if let options = ggufOptions[repo] {
            if options.isEmpty {
                Text("No downloadable GGUF files found in this repo.")
                    .font(AppFont.mono(11))
                    .foregroundColor(colors.textTertiary)
                    .padding(.vertical, 6)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(options.enumerated()), id: \.element.id) { index, file in
                        if index > 0 { Divider().overlay(colors.borderSubtle.opacity(0.6)) }
                        hfVariantRow(repo: repo, file: file)
                    }
                }
            }
        } else {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Loading variants…")
                    .font(AppFont.mono(11))
                    .foregroundColor(colors.textTertiary)
            }
            .padding(.vertical, 8)
            .task(id: repo) {
                guard ggufOptions[repo] == nil else { return }
                let files = (try? await manager.listGGUFFiles(repo: repo)) ?? []
                ggufOptions[repo] = files
            }
        }
    }

    private func hfVariantRow(repo: String, file: LocalAIManager.GGUFFile) -> some View {
        let estimate = ModelFitEstimator.assess(downloadSizeBytes: file.size, backend: hfFormat.backend)
        let isDefault = hfDefaultQuant[repo] == file.quantLabel && !file.quantLabel.isEmpty
        let sizeClass = Self.quantSizeClass(file.quantLabel)
        let fits = estimate.verdict != .tooBig

        return HStack(spacing: 8) {
            Text(Self.variantDisplayName(file))
                .font(AppFont.mono(11.5, weight: .medium))
                .foregroundColor(colors.textPrimary)
                .lineLimit(1)
                .truncationMode(.middle)

            if let sizeClass {
                TagChip(text: sizeClass.text, color: sizeClass.color)
            }
            if isDefault {
                TagChip(text: "Recommended", color: Color(hex: "#F59E0B"))
            }

            Spacer(minLength: 8)

            Text(String(format: "%.1f GB", Double(file.size) / 1_000_000_000))
                .font(AppFont.mono(11))
                .foregroundColor(colors.textTertiary)

            Image(systemName: fits ? "checkmark" : "exclamationmark.triangle.fill")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(fits ? Color(hex: "#34C759") : colors.destructive)
                .frame(width: 16)
                .help(estimate.detail)

            Button {
                if estimate.verdict == .tooBig {
                    pendingTooBigDownload = (repo, file)
                } else {
                    manager.startHFDownload(repo: repo, file: file) { modelId in
                        if let modelId { onStartChat(modelId) }
                    }
                }
            } label: {
                Image(systemName: "arrow.down.circle")
                    .font(.system(size: 13))
                    .foregroundStyle(colors.textSecondary)
                    .iconHoverEffect(for: "arrow.down.circle")
                    .frame(width: 22, height: 22)
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressableButtonStyle())
            .help("Download this quantization")
        }
        .padding(.vertical, 8)
    }

    /// The filename stem shown for a variant — "…-Q4_K_M.gguf" → the bare
    /// name, matching how the reference lists each quantization.
    private static func variantDisplayName(_ file: LocalAIManager.GGUFFile) -> String {
        let base = (file.path as NSString).lastPathComponent
        if let range = base.range(of: ".gguf", options: [.caseInsensitive, .backwards]) {
            return String(base[..<range.lowerBound])
        }
        return base
    }

    /// A rough quality/size class from the quant label — the same
    /// small/balanced/large grouping the reference shows, derived from the
    /// quantization level (Q2/Q3 trade quality for size, Q4/Q5 are the
    /// balanced sweet spot, Q6/Q8/F16 keep the most quality at the most
    /// disk). nil when the label doesn't name a recognized quant.
    private static func quantSizeClass(_ label: String) -> (text: String, color: Color)? {
        let l = label.lowercased()
        if l.contains("q2") || l.contains("q3") { return ("Small", Color(hex: "#5B9BFF")) }
        if l.contains("q4") || l.contains("q5") { return ("Balanced", Color(hex: "#34C759")) }
        if l.contains("q6") || l.contains("q8") || l.contains("f16") || l.contains("f32") { return ("Large", Color(hex: "#F59E0B")) }
        return nil
    }

    private static func formatCount(_ count: Int) -> String {
        if count >= 1_000_000 { return String(format: "%.1fM", Double(count) / 1_000_000) }
        if count >= 1_000 { return String(format: "%.0fk", Double(count) / 1_000) }
        return "\(count)"
    }

    // MARK: On this Mac

    @ViewBuilder
    private var onThisMacSection: some View {
        HStack(spacing: 6) {
            Image(systemName: "laptopcomputer")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(colors.textSecondary)
            Text("On this Mac")
                .font(AppFont.mono(14, weight: .semibold))
                .foregroundStyle(colors.textPrimary)
            if !manager.allLocalModels.isEmpty {
                Text("\(manager.allLocalModels.count)")
                    .font(AppFont.mono(11))
                    .foregroundColor(colors.textTertiary)
            }
        }
        .padding(.top, 10)

        if manager.allLocalModels.isEmpty {
            Text("Nothing yet. Download a model above and it appears here, ready to chat.")
                .font(AppFont.mono(12))
                .foregroundColor(colors.textSecondary)
        } else {
            SettingsCard {
                LazyVStack(spacing: 0) {
                    ForEach(Array(manager.allLocalModels.enumerated()), id: \.element.id) { index, record in
                        if index > 0 { Divider().padding(.leading, 16) }
                        localRow(record)
                    }
                }
            }
        }
    }

    /// llama.cpp/MLX records link to their originating Hugging Face repo
    /// when they have one (not for a single-file download, which has no
    /// repo-root page worth landing on). `nil` means genuinely nothing to
    /// link to — an old persisted record from before `source` was tracked,
    /// say. Ollama-backed records always have somewhere to link (their own
    /// library page), handled separately below.
    private func huggingFaceRepo(for record: LocalModelRecord) -> String? {
        guard record.backend != .ollama, let source = record.source, record.isFile != true else { return nil }
        return source
    }

    @ViewBuilder
    private func localRowInfo(_ record: LocalModelRecord) -> some View {
        let info = VStack(alignment: .leading, spacing: 2) {
            Text(record.displayName)
                .font(AppFont.mono(13, weight: .medium))
                .foregroundColor(colors.textPrimary)
                .lineLimit(1)
            Text("\(record.backend.displayName) · \(record.detail)")
                .font(AppFont.mono(11))
                .foregroundColor(colors.textTertiary)
                .lineLimit(1)
            // Real specs straight from Ollama's own `/api/tags` for a model
            // already on this Mac — no fetch needed, no guessing. llama.cpp
            // MLX records have none of these fields, so the row just
            // doesn't render for them.
            SpecChipRow(chips: Self.specChips(
                paramSize: record.paramSize,
                quantization: record.quantization,
                family: record.family,
                contextLength: record.contextLength
            ))
        }
        .contentShape(Rectangle())

        if record.backend == .ollama {
            Button {
                openOllamaLibraryPage(for: record.requestModelId)
            } label: {
                info
            }
            .buttonStyle(.plain)
            .help("Open \(record.displayName) on ollama.com")
        } else if let repo = huggingFaceRepo(for: record) {
            Button {
                openHuggingFacePage(for: repo)
            } label: {
                info
            }
            .buttonStyle(.plain)
            .help("Open \(record.displayName) on huggingface.co")
        } else {
            info
        }
    }

    private func localRow(_ record: LocalModelRecord) -> some View {
        HStack(spacing: 12) {
            // The backend is already named in the subtitle below, so this
            // chip is free to show the more distinctive fact: who made it.
            ModelOriginBadge(brand: LocalAIManager.guessBrand(forName: record.requestModelId), size: 28)

            localRowInfo(record)

            Spacer(minLength: 12)

            chatButton(modelId: record.id)

            if record.backend == .llamaCpp {
                LlamaRunSettingsMenu(manager: manager, record: record)
            }

            Button {
                recordPendingDeletion = record
            } label: {
                Image(systemName: "trash")
                    .font(.system(size: 12))
                    .foregroundColor(colors.textSecondary)
                    .iconHoverEffect(for: "trash")
                    .frame(width: 26, height: 26)
            }
            .buttonStyle(.plain)
            .help("Delete from this Mac")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private func deleteRecord(_ record: LocalModelRecord) {
        Task {
            // Surface a verified failure instead of pretending — see
            // `LocalAIManager.deleteModel`'s own doc for the live bug
            // (models "deleted" in the UI, 20GB unchanged on disk).
            if let failure = await manager.deleteModel(record) {
                deletionFailureMessage = failure
            }
        }
    }

    // MARK: Shared bits

    private func chatButton(modelId: String) -> some View {
        Button {
            onStartChat(modelId)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "bubble.left.fill")
                    .font(.system(size: 9))
                    .iconHoverEffect(for: "bubble.left.fill")
                Text("Chat")
                    .font(AppFont.mono(11, weight: .semibold))
            }
            .foregroundStyle(colors.backgroundPrimary)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Capsule().fill(colors.textPrimary))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .help("Start a chat with this model")
    }

    private func downloadButton(disabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: "arrow.down.circle")
                    .font(.system(size: 11))
                    .iconHoverEffect(for: "arrow.down.circle")
                Text("Download")
                    .font(AppFont.mono(11, weight: .medium))
            }
            .foregroundStyle(colors.textPrimary)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Capsule().stroke(colors.borderMedium, lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
    }

    // MARK: Origin badge

    /// Who actually made this model — a real logo where one exists
    /// (`ProviderBadge`, the same brand chip used across Settings and the
    /// Model Picker), or an honest neutral chip when no single company can
    /// be credited (a community fine-tune or research-group release), never
    /// a blank gap or a misattributed guess.
    private struct ModelOriginBadge: View {
        @Environment(\.themeColors) private var colors
        let brand: ProviderBrand?
        var size: CGFloat = 26

        var body: some View {
            Group {
                if let brand {
                    ProviderBadge(brand: brand, size: size)
                } else {
                    Circle()
                        .fill(colors.backgroundChipSecondary)
                        .overlay(Circle().stroke(colors.borderSubtle, lineWidth: 1))
                        .overlay {
                            Image(systemName: "shippingbox")
                                .font(.system(size: size * 0.42, weight: .medium))
                                .foregroundStyle(colors.textTertiary)
                        }
                        .help("No single company credited. A community or research release.")
                }
            }
            .frame(width: size, height: size)
        }
    }

    /// A small, impossible-to-miss flag for a genuinely current release
    /// (`CuratedOllamaModel.isNew`) — real freshness has to be visible at a
    /// glance in a list of 140+ models spanning years of releases, not just
    /// true in the data. Solid fill (not the app's usual outline-chip
    /// style) so it reads as a flag, not just more label text.
    private struct NewModelBadge: View {
        var body: some View {
            Text("NEW")
                .font(AppFont.mono(9, weight: .bold))
                .foregroundStyle(.white)
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .background(Capsule().fill(Color(hex: "#22C55E")))
        }
    }

    /// A compact "will this run here" verdict, shown before the user
    /// downloads — colored like a real traffic light (not filtered through
    /// the app's usual monochrome palette) since it's a genuine status
    /// signal, matching the same precedent as the local-backend running dot.
    /// Hover for the exact numbers behind the verdict.
    private struct ModelFitBadge: View {
        @Environment(\.themeColors) private var colors
        let estimate: ModelFitEstimate

        private var tint: Color {
            switch estimate.verdict {
            case .comfortable: return Color(hex: "#34C759")
            case .tight: return Color(hex: "#F59E0B")
            case .tooBig: return colors.destructive
            }
        }

        private var icon: String {
            switch estimate.verdict {
            case .comfortable: return "checkmark.circle.fill"
            case .tight: return "exclamationmark.triangle.fill"
            case .tooBig: return "xmark.circle.fill"
            }
        }

        var body: some View {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 9, weight: .semibold))
                Text(estimate.headline)
                    .font(AppFont.mono(10.5, weight: .medium))
            }
            .foregroundStyle(tint)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(Capsule().fill(tint.opacity(0.14)))
            .help(estimate.detail)
        }
    }

    /// A small tinted label chip — the "Small"/"Balanced"/"Large" size
    /// class and the "Recommended" flag on each quantization variant.
    private struct TagChip: View {
        let text: String
        let color: Color

        var body: some View {
            Text(text)
                .font(AppFont.mono(9.5, weight: .semibold))
                .foregroundStyle(color)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Capsule().fill(color.opacity(0.15)))
        }
    }

    /// One real fact (params, quant, family, context) as a small monospace
    /// tag — the terminal-readout building block `specChips` feeds into.
    private struct SpecChip: View {
        @Environment(\.themeColors) private var colors
        let text: String

        var body: some View {
            Text(text)
                .font(AppFont.mono(10, weight: .medium))
                .foregroundStyle(colors.textSecondary)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(RoundedRectangle(cornerRadius: 4, style: .continuous).fill(colors.backgroundChipSecondary))
        }
    }

    private struct SpecChipRow: View {
        let chips: [String]

        var body: some View {
            if !chips.isEmpty {
                HStack(spacing: 4) {
                    ForEach(chips, id: \.self) { SpecChip(text: $0) }
                }
            }
        }
    }

    private struct ModelFitLoadingBadge: View {
        @Environment(\.themeColors) private var colors
        var body: some View {
            HStack(spacing: 4) {
                ProgressView().controlSize(.mini)
                Text("Checking fit…")
                    .font(AppFont.mono(10.5))
            }
            .foregroundStyle(colors.textTertiary)
        }
    }

    private func missingBackendCard(_ backend: LocalBackend) -> some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 8) {
                Text("\(backend.displayName) is needed for this")
                    .font(AppFont.mono(14, weight: .semibold))
                    .foregroundColor(colors.textPrimary)
                Text(backend.installNote)
                    .font(AppFont.sans(12))
                    .foregroundColor(colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
                HStack(spacing: 8) {
                    Text(backend.installCommand)
                        .font(AppFont.mono(12))
                        .foregroundColor(colors.textPrimary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(colors.backgroundInput)
                        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                        .textSelection(.enabled)
                    Button("Copy") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(backend.installCommand, forType: .string)
                    }
                    .buttonStyle(.bordered)
                    AccentButton(title: "Check again") {
                        Task { await manager.refreshInstalledBackends(force: true) }
                    }
                }
                Button("See every local runner and its install command →") {
                    showingInstallGuide = true
                }
                .buttonStyle(.plain)
                .font(AppFont.mono(11, weight: .medium))
                .foregroundColor(colors.link)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
