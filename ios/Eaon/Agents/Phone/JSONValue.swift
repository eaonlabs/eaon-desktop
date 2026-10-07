import Foundation

/// A JSON value, for the arguments a model passes to a tool.
enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let bool = try? container.decode(Bool.self) {
            self = .bool(bool)
        } else if let number = try? container.decode(Double.self) {
            self = .number(number)
        } else if let string = try? container.decode(String.self) {
            self = .string(string)
        } else if let array = try? container.decode([JSONValue].self) {
            self = .array(array)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    static func parse(_ text: String) -> JSONValue? {
        guard let data = text.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: data)
    }

    var string: String? {
        switch self {
        case .string(let value): value
        case .number(let value): value == value.rounded() ? String(Int(value)) : String(value)
        case .bool(let value): String(value)
        default: nil
        }
    }

    var int: Int? {
        switch self {
        case .number(let value): Int(exactly: value.rounded())
        case .string(let value): Int(value.trimmingCharacters(in: .whitespaces))
        default: nil
        }
    }

    var bool: Bool? {
        switch self {
        case .bool(let value): value
        case .string(let value): ["true", "yes", "1"].contains(value.lowercased()) ? true : (["false", "no", "0"].contains(value.lowercased()) ? false : nil)
        default: nil
        }
    }

    var array: [JSONValue]? {
        if case .array(let value) = self { value } else { nil }
    }

    var object: [String: JSONValue]? {
        if case .object(let value) = self { value } else { nil }
    }

    subscript(key: String) -> JSONValue? {
        object?[key]
    }

    /// Compact JSON with sorted keys: the same arguments always give the same text, so two calls can be compared.
    var canonical: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(self), let text = String(data: data, encoding: .utf8) else { return "null" }
        return text
    }
}

typealias JSONObject = [String: JSONValue]

extension Dictionary where Key == String, Value == JSONValue {
    func string(_ key: String) -> String? { self[key]?.string?.trimmingCharacters(in: .whitespacesAndNewlines) }
    func int(_ key: String) -> Int? { self[key]?.int }
    func bool(_ key: String) -> Bool? { self[key]?.bool }
    func strings(_ key: String) -> [String] { self[key]?.array?.compactMap(\.string) ?? [] }
}
