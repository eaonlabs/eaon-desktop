// eaon-vm: runs Eaon's virtual machines on a Mac, with Apple's Virtualization
// framework. Eaon (src/main/vms/vz.ts) starts it detached, so a VM keeps
// running while Eaon restarts or updates, and talks to it through files and
// signals rather than pipes:
//
//   eaon-vm check                       what this Mac can run, as JSON
//   eaon-vm macos-latest                the newest macOS this Mac can run in a VM
//   eaon-vm macos-install <config> <ipsw>   installs macOS onto the config's disk
//   eaon-vm run <config>                runs the VM until it stops
//
// While it runs, <dir>/run.json says how: {"pid", "state", "vncPort"} and,
// once it stops, why. SIGTERM asks the guest to shut down (and forces it
// after a while); SIGINT stops it at once. The screen is served over VNC on
// 127.0.0.1 with a password, through the framework's own VNC server.

import Foundation
import Virtualization

struct Config: Decodable {
  var kind: String
  var cpus: Int
  var memoryMB: UInt64
  var disk: String
  var seed: String?
  var efiStore: String?
  var machineId: String?
  var hardwareModel: String?
  var auxStorage: String?
  var macAddress: String
  var width: Int
  var height: Int
  var vncPassword: String
  var console: String?
  /// A second serial port (the guest's /dev/hvc1), kept as a file: the first boot's setup writes its
  /// progress there, apart from the console, where a login prompt runs.
  var setupLog: String?
  /// Local sockets that reach a port inside the guest over vsock, so Eaon can
  /// SSH in without touching the network (and without macOS's Local Network
  /// permission): each connection to `socket` becomes one to the guest's `port`.
  var bridges: [Bridge]?
}

struct Bridge: Decodable {
  var socket: String
  var port: UInt32
}

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) else { return }
  FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

func fail(_ message: String) -> Never {
  emit(["event": "error", "error": message])
  exit(1)
}

func loadConfig(_ path: String) -> Config {
  do {
    return try JSONDecoder().decode(Config.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
  } catch {
    fail("The VM's settings couldn't be read: \(error.localizedDescription)")
  }
}

func clamp<T: Comparable>(_ value: T, _ low: T, _ high: T) -> T { min(max(value, low), high) }

/* ------------------------------------------------------------- devices */

func storage(_ config: Config) throws -> [VZStorageDeviceConfiguration] {
  var devices: [VZStorageDeviceConfiguration] = []
  // Linux guests get the host's cache: with .automatic, Ubuntu's kernel saw I/O errors under heavy
  // writes (installing a desktop) and its filesystem went read-only. Lima settled on the same.
  let caching: VZDiskImageCachingMode = config.kind == "macos" ? .automatic : .cached
  let disk = try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: config.disk), readOnly: false, cachingMode: caching, synchronizationMode: .fsync)
  devices.append(VZVirtioBlockDeviceConfiguration(attachment: disk))
  if let seed = config.seed, FileManager.default.fileExists(atPath: seed) {
    let attachment = try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: seed), readOnly: true)
    devices.append(VZVirtioBlockDeviceConfiguration(attachment: attachment))
  }
  return devices
}

func network(_ config: Config) -> [VZNetworkDeviceConfiguration] {
  let device = VZVirtioNetworkDeviceConfiguration()
  device.attachment = VZNATNetworkDeviceAttachment()
  if let address = VZMACAddress(string: config.macAddress) { device.macAddress = address }
  return [device]
}

func common(_ conf: VZVirtualMachineConfiguration, _ config: Config) throws {
  let maxCPUs = VZVirtualMachineConfiguration.maximumAllowedCPUCount
  conf.cpuCount = clamp(config.cpus, VZVirtualMachineConfiguration.minimumAllowedCPUCount, maxCPUs)
  conf.memorySize = clamp(config.memoryMB * 1024 * 1024, VZVirtualMachineConfiguration.minimumAllowedMemorySize, VZVirtualMachineConfiguration.maximumAllowedMemorySize)
  conf.storageDevices = try storage(config)
  conf.networkDevices = network(config)
  conf.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
  conf.socketDevices = [VZVirtioSocketDeviceConfiguration()]
  conf.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]
}

func linuxConfiguration(_ config: Config) throws -> VZVirtualMachineConfiguration {
  let conf = VZVirtualMachineConfiguration()
  try common(conf, config)
  let platform = VZGenericPlatformConfiguration()
  if let path = config.machineId {
    let url = URL(fileURLWithPath: path)
    if let data = try? Data(contentsOf: url), let id = VZGenericMachineIdentifier(dataRepresentation: data) {
      platform.machineIdentifier = id
    } else {
      try platform.machineIdentifier.dataRepresentation.write(to: url)
    }
  }
  conf.platform = platform
  guard let storePath = config.efiStore else { throw NSError(domain: "eaon-vm", code: 1, userInfo: [NSLocalizedDescriptionKey: "No EFI store was given."]) }
  let storeURL = URL(fileURLWithPath: storePath)
  let loader = VZEFIBootLoader()
  loader.variableStore = FileManager.default.fileExists(atPath: storePath) ? VZEFIVariableStore(url: storeURL) : try VZEFIVariableStore(creatingVariableStoreAt: storeURL)
  conf.bootLoader = loader
  let graphics = VZVirtioGraphicsDeviceConfiguration()
  graphics.scanouts = [VZVirtioGraphicsScanoutConfiguration(widthInPixels: config.width, heightInPixels: config.height)]
  conf.graphicsDevices = [graphics]
  conf.keyboards = [VZUSBKeyboardConfiguration()]
  conf.pointingDevices = [VZUSBScreenCoordinatePointingDeviceConfiguration()]
  var ports: [VZSerialPortConfiguration] = []
  for path in [config.console, config.setupLog].compactMap({ $0 }) {
    if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
    if let handle = FileHandle(forWritingAtPath: path) {
      handle.seekToEndOfFile()
      let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
      serial.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: nil, fileHandleForWriting: handle)
      ports.append(serial)
    }
  }
  conf.serialPorts = ports
  try conf.validate()
  return conf
}

#if arch(arm64)
func macPlatform(_ config: Config) throws -> VZMacPlatformConfiguration {
  guard let hw = config.hardwareModel, let mid = config.machineId, let aux = config.auxStorage,
        let model = VZMacHardwareModel(dataRepresentation: try Data(contentsOf: URL(fileURLWithPath: hw))),
        let identifier = VZMacMachineIdentifier(dataRepresentation: try Data(contentsOf: URL(fileURLWithPath: mid))) else {
    throw NSError(domain: "eaon-vm", code: 2, userInfo: [NSLocalizedDescriptionKey: "This macOS VM's identity files are missing; install it again."])
  }
  let platform = VZMacPlatformConfiguration()
  platform.hardwareModel = model
  platform.machineIdentifier = identifier
  platform.auxiliaryStorage = VZMacAuxiliaryStorage(url: URL(fileURLWithPath: aux))
  return platform
}

func macConfiguration(_ config: Config, platform: VZMacPlatformConfiguration) throws -> VZVirtualMachineConfiguration {
  let conf = VZVirtualMachineConfiguration()
  try common(conf, config)
  conf.platform = platform
  conf.bootLoader = VZMacOSBootLoader()
  let graphics = VZMacGraphicsDeviceConfiguration()
  graphics.displays = [VZMacGraphicsDisplayConfiguration(widthInPixels: config.width, heightInPixels: config.height, pixelsPerInch: 80)]
  conf.graphicsDevices = [graphics]
  if #available(macOS 14, *) {
    conf.keyboards = [VZMacKeyboardConfiguration()]
  } else {
    conf.keyboards = [VZUSBKeyboardConfiguration()]
  }
  // Absolute pointing first: VNC sends where the pointer is, not how far it moved.
  conf.pointingDevices = [VZUSBScreenCoordinatePointingDeviceConfiguration(), VZMacTrackpadConfiguration()]
  try conf.validate()
  return conf
}
#endif

/// A macOS guest's configuration, or why there can't be one (an Intel Mac).
func guestConfiguration(_ config: Config) throws -> VZVirtualMachineConfiguration {
  if config.kind != "macos" { return try linuxConfiguration(config) }
  #if arch(arm64)
    return try macConfiguration(config, platform: try macPlatform(config))
  #else
    throw NSError(domain: "eaon-vm", code: 3, userInfo: [NSLocalizedDescriptionKey: "macOS VMs need a Mac with Apple silicon."])
  #endif
}

/* ---------------------------------------------------------------- VNC */

/// The framework's own VNC server. It's private, so it's reached through the
/// Objective-C runtime and checked at every step: if a macOS release drops
/// it, the VM still runs, only without a screen to watch. It picks its port
/// once it is listening, which `listeningPort(of:)` reads.
func startVNC(_ vm: VZVirtualMachine, password: String) -> NSObject? {
  guard let serverClass = NSClassFromString("_VZVNCServer") as? NSObject.Type,
        let securityClass = NSClassFromString("_VZVNCAuthenticationSecurityConfiguration") as? NSObject.Type else { return nil }
  let initPassword = NSSelectorFromString("initWithPassword:")
  guard let securityAlloc = securityClass.perform(NSSelectorFromString("alloc"))?.takeUnretainedValue() as? NSObject,
        securityAlloc.responds(to: initPassword),
        let security = securityAlloc.perform(initPassword, with: password)?.takeUnretainedValue() as? NSObject else { return nil }
  let initPort = NSSelectorFromString("initWithPort:queue:securityConfiguration:")
  guard let serverAlloc = serverClass.perform(NSSelectorFromString("alloc"))?.takeUnretainedValue() as? NSObject, serverAlloc.responds(to: initPort) else { return nil }
  typealias InitFn = @convention(c) (NSObject, Selector, UInt16, DispatchQueue, NSObject) -> NSObject?
  let initialise = unsafeBitCast(serverAlloc.method(for: initPort), to: InitFn.self)
  guard let server = initialise(serverAlloc, initPort, 0, DispatchQueue.main, security) else { return nil }
  let setVM = NSSelectorFromString("setVirtualMachine:")
  guard server.responds(to: setVM), server.responds(to: NSSelectorFromString("start")), server.responds(to: NSSelectorFromString("port")) else { return nil }
  server.perform(setVM, with: vm)
  server.perform(NSSelectorFromString("start"))
  return server
}

func listeningPort(of server: NSObject) -> UInt16 {
  typealias PortFn = @convention(c) (NSObject, Selector) -> UInt16
  let selector = NSSelectorFromString("port")
  return unsafeBitCast(server.method(for: selector), to: PortFn.self)(server, selector)
}

/* ------------------------------------------------------------ bridges */

/// Copies bytes one way until either side closes, then closes both.
func pump(from source: Int32, to sink: Int32, done: @escaping () -> Void) {
  Thread.detachNewThread {
    var buffer = [UInt8](repeating: 0, count: 65536)
    while true {
      let count = read(source, &buffer, buffer.count)
      if count <= 0 { break }
      var offset = 0
      while offset < count {
        let written = buffer[offset..<count].withUnsafeBytes { write(sink, $0.baseAddress, count - offset) }
        if written <= 0 { done(); return }
        offset += written
      }
    }
    done()
  }
}

/// Listens on a Unix socket only this user can reach, and hands each
/// connection to the guest's vsock `port`.
final class VsockBridge {
  let path: String
  let port: UInt32
  let device: VZVirtioSocketDevice
  var listener: Int32 = -1
  var source: DispatchSourceRead?

  init(path: String, port: UInt32, device: VZVirtioSocketDevice) {
    self.path = path
    self.port = port
    self.device = device
  }

  func start() -> Bool {
    unlink(path)
    listener = socket(AF_UNIX, SOCK_STREAM, 0)
    guard listener >= 0 else { return false }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { return false }
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
      for (i, byte) in bytes.enumerated() { raw[i] = byte }
    }
    let size = socklen_t(MemoryLayout<sockaddr_un>.size)
    let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, size) } }
    guard bound == 0, listen(listener, 16) == 0 else { return false }
    chmod(path, 0o600)
    // Never block the queue the VM runs on: a connection that goes before it's
    // accepted would leave accept() waiting, and the VM with it.
    _ = fcntl(listener, F_SETFL, fcntl(listener, F_GETFL) | O_NONBLOCK)
    let source = DispatchSource.makeReadSource(fileDescriptor: listener, queue: .main)
    source.setEventHandler { [weak self] in self?.accept() }
    source.resume()
    self.source = source
    return true
  }

  func accept() {
    while true {
      let client = Darwin.accept(listener, nil, nil)
      guard client >= 0 else { return }
      // The listener doesn't block; its connections should.
      _ = fcntl(client, F_SETFL, fcntl(client, F_GETFL) & ~O_NONBLOCK)
      connect(client)
    }
  }

  func connect(_ client: Int32) {
    device.connect(toPort: port) { result in
      switch result {
      case .failure(let error):
        emit(["event": "bridge", "port": Int(self.port), "error": error.localizedDescription])
        close(client)
      case .success(let connection):
        // The connection closes its descriptor when it goes, so it's kept until both directions end.
        let guest = connection.fileDescriptor
        var open = 2
        let lock = NSLock()
        let finished = {
          lock.lock()
          open -= 1
          let last = open == 0
          lock.unlock()
          shutdown(client, SHUT_RDWR)
          shutdown(guest, SHUT_RDWR)
          if last {
            close(client)
            DispatchQueue.main.async { connection.close() }
          }
        }
        pump(from: client, to: guest, done: finished)
        pump(from: guest, to: client, done: finished)
      }
    }
  }

  func stop() {
    source?.cancel()
    if listener >= 0 { close(listener) }
    unlink(path)
  }
}

/* ---------------------------------------------------------------- run */

final class Runner: NSObject, VZVirtualMachineDelegate {
  let config: Config
  let statePath: String
  var vm: VZVirtualMachine?
  var vnc: NSObject?
  var vncPort: UInt16 = 0
  var bridges: [VsockBridge] = []
  var stopping = false
  var signalSources: [DispatchSourceSignal] = []

  init(config: Config, statePath: String) {
    self.config = config
    self.statePath = statePath
  }

  func writeState(_ state: String, extra: [String: Any] = [:]) {
    var object: [String: Any] = ["pid": Int(getpid()), "state": state, "vncPort": Int(vncPort), "at": Int(Date().timeIntervalSince1970 * 1000)]
    for (key, value) in extra { object[key] = value }
    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
    let temp = statePath + ".tmp"
    if FileManager.default.createFile(atPath: temp, contents: data) {
      _ = rename(temp, statePath)
    }
    emit(object.merging(["event": state]) { a, _ in a })
  }

  func finish(_ reason: String, error: String? = nil) -> Never {
    for bridge in bridges { bridge.stop() }
    var extra: [String: Any] = ["reason": reason]
    if let error { extra["error"] = error }
    writeState("stopped", extra: extra)
    exit(error == nil ? 0 : 1)
  }

  func start() {
    let conf: VZVirtualMachineConfiguration
    do {
      conf = try guestConfiguration(config)
    } catch {
      finish("error", error: error.localizedDescription)
    }
    let vm = VZVirtualMachine(configuration: conf)
    vm.delegate = self
    self.vm = vm
    writeState("starting")
    vm.start { result in
      switch result {
      case .success:
        if let device = vm.socketDevices.first as? VZVirtioSocketDevice {
          for bridge in self.config.bridges ?? [] {
            let made = VsockBridge(path: bridge.socket, port: bridge.port, device: device)
            if made.start() { self.bridges.append(made) }
          }
        }
        self.vnc = startVNC(vm, password: self.config.vncPassword)
        self.writeState("running")
        if self.vnc != nil { self.awaitVNCPort(tries: 100) }
      case .failure(let error):
        self.finish("error", error: error.localizedDescription)
      }
    }
    for (number, graceful) in [(SIGTERM, true), (SIGINT, false)] {
      signal(number, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
      source.setEventHandler { [weak self] in self?.stop(graceful: graceful) }
      source.resume()
      signalSources.append(source)
    }
  }

  /// Polls (without blocking the queue the server works on) until it has a port, then says so.
  func awaitVNCPort(tries: Int) {
    guard let vnc, tries > 0 else { return }
    let port = listeningPort(of: vnc)
    if port != 0 {
      vncPort = port
      writeState(stopping ? "stopping" : "running")
      return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in self?.awaitVNCPort(tries: tries - 1) }
  }

  func stop(graceful: Bool) {
    guard let vm else { finish("stopped") }
    if graceful && vm.canRequestStop && !stopping {
      stopping = true
      writeState("stopping")
      try? vm.requestStop()
      // A guest that ignores the power button is stopped anyway.
      DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in self?.stop(graceful: false) }
      return
    }
    if vm.canStop {
      vm.stop { _ in self.finish("stopped") }
    } else {
      finish("stopped")
    }
  }

  func guestDidStop(_ virtualMachine: VZVirtualMachine) {
    finish("guest")
  }

  func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
    finish("error", error: error.localizedDescription)
  }
}

/* ------------------------------------------------------------- install */

#if arch(arm64)
final class Installer: NSObject {
  var installer: VZMacOSInstaller?
  var observation: NSKeyValueObservation?

  func install(_ config: Config, ipsw: String) {
    VZMacOSRestoreImage.load(from: URL(fileURLWithPath: ipsw)) { result in
      DispatchQueue.main.async {
        switch result {
        case .failure(let error):
          fail("The macOS installer couldn't be read: \(error.localizedDescription)")
        case .success(let image):
          self.begin(config, image: image, ipsw: ipsw)
        }
      }
    }
  }

  func begin(_ config: Config, image: VZMacOSRestoreImage, ipsw: String) {
    guard let requirements = image.mostFeaturefulSupportedConfiguration, requirements.hardwareModel.isSupported else {
      fail("This Mac can't run that version of macOS in a VM.")
    }
    guard let hw = config.hardwareModel, let mid = config.machineId, let aux = config.auxStorage else { fail("The VM's identity paths are missing.") }
    do {
      try requirements.hardwareModel.dataRepresentation.write(to: URL(fileURLWithPath: hw))
      try VZMacMachineIdentifier().dataRepresentation.write(to: URL(fileURLWithPath: mid))
      _ = try VZMacAuxiliaryStorage(creatingStorageAt: URL(fileURLWithPath: aux), hardwareModel: requirements.hardwareModel, options: [.allowOverwrite])
      var sized = config
      sized.cpus = max(config.cpus, requirements.minimumSupportedCPUCount)
      sized.memoryMB = max(config.memoryMB, requirements.minimumSupportedMemorySize / 1024 / 1024)
      let conf = try macConfiguration(sized, platform: try macPlatform(sized))
      let vm = VZVirtualMachine(configuration: conf)
      let installer = VZMacOSInstaller(virtualMachine: vm, restoringFromImageAt: URL(fileURLWithPath: ipsw))
      self.installer = installer
      emit(["event": "installing", "progress": 0])
      observation = installer.progress.observe(\.fractionCompleted, options: [.new]) { progress, _ in
        emit(["event": "installing", "progress": progress.fractionCompleted])
      }
      installer.install { result in
        switch result {
        case .success:
          emit(["event": "installed"])
          exit(0)
        case .failure(let error):
          fail("macOS didn't install: \(error.localizedDescription)")
        }
      }
    } catch {
      fail(error.localizedDescription)
    }
  }
}
#endif

/* ---------------------------------------------------------------- main */

let args = CommandLine.arguments
guard args.count >= 2 else {
  fail("usage: eaon-vm check | macos-latest | macos-install <config> <ipsw> | run <config>")
}

switch args[1] {
case "check":
  var arch = "x86_64"
  #if arch(arm64)
    arch = "arm64"
  #endif
  let os = ProcessInfo.processInfo.operatingSystemVersion
  emit([
    "supported": VZVirtualMachine.isSupported,
    "arch": arch,
    "macos": "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)",
    "maxCPUs": VZVirtualMachineConfiguration.maximumAllowedCPUCount,
    "maxMemoryMB": Int(VZVirtualMachineConfiguration.maximumAllowedMemorySize / 1024 / 1024),
    "vnc": NSClassFromString("_VZVNCServer") != nil
  ])

case "macos-latest":
  #if arch(arm64)
    VZMacOSRestoreImage.fetchLatestSupported { result in
      switch result {
      case .success(let image):
        let v = image.operatingSystemVersion
        emit(["url": image.url.absoluteString, "build": image.buildVersion, "version": "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"])
        exit(0)
      case .failure(let error):
        fail("Apple's list of macOS versions couldn't be read: \(error.localizedDescription)")
      }
    }
    dispatchMain()
  #else
    fail("macOS VMs need a Mac with Apple silicon.")
  #endif

case "macos-install":
  guard args.count >= 4 else { fail("usage: eaon-vm macos-install <config> <ipsw>") }
  #if arch(arm64)
    let installer = Installer()
    installer.install(loadConfig(args[2]), ipsw: args[3])
    dispatchMain()
  #else
    fail("macOS VMs need a Mac with Apple silicon.")
  #endif

case "run":
  guard args.count >= 3 else { fail("usage: eaon-vm run <config>") }
  let configPath = args[2]
  let runner = Runner(config: loadConfig(configPath), statePath: (configPath as NSString).deletingLastPathComponent + "/run.json")
  DispatchQueue.main.async { runner.start() }
  dispatchMain()

default:
  fail("Unknown command \(args[1]).")
}
