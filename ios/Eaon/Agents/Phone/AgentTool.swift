import Foundation

/// What a tool does to the world, which decides who may use it.
enum ToolRisk: Sendable {
    /// Looks only: reads a page, the calendar.
    case read
    /// Touches only the agent itself: its notes, its schedule, a question for the person.
    case own
    /// Changes something of the person's: adds an event or a reminder.
    case write
}

struct ToolParameter: Sendable {
    enum Kind: Sendable {
        case string
        case integer
        case boolean
        case strings
        /// One of a fixed set of words.
        case choice([String])
    }

    var name: String
    var kind: Kind
    var description: String
    var required = false
}

/// One thing an agent can do. The model sees `name`, `description` and
/// `parameters`; `run` does it. A tool takes plain JSON arguments and answers
/// with a short piece of text for the model to read.
struct AgentTool: Sendable {
    var name: String
    var description: String
    var parameters: [ToolParameter] = []
    var risk: ToolRisk
    /// Kept for the small on-device model, whose window can't hold every tool.
    var core = true
    /// "Read a web page", for the transcript.
    var title: @Sendable (JSONObject) -> String
    /// The line under the title: the address, the reminder's text.
    var detail: @Sendable (JSONObject) -> String? = { _ in nil }
    var run: @MainActor @Sendable (JSONObject) async throws -> String

    /// The OpenAI "function" definition.
    var openAIDefinition: [String: Any] {
        var properties: [String: Any] = [:]
        for parameter in parameters {
            var schema: [String: Any]
            switch parameter.kind {
            case .string: schema = ["type": "string"]
            case .integer: schema = ["type": "integer"]
            case .boolean: schema = ["type": "boolean"]
            case .strings: schema = ["type": "array", "items": ["type": "string"]]
            case .choice(let words): schema = ["type": "string", "enum": words]
            }
            schema["description"] = parameter.description
            properties[parameter.name] = schema
        }
        return [
            "type": "function",
            "function": [
                "name": name,
                "description": description,
                "parameters": [
                    "type": "object",
                    "properties": properties,
                    "required": parameters.filter(\.required).map(\.name)
                ] as [String: Any]
            ] as [String: Any]
        ]
    }
}

/// Why a tool wouldn't run.
struct ToolRefusal: Error, Equatable {
    var message: String
}
