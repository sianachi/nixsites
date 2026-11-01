import Foundation

/// A SQLite value as it crosses the page boundary: null, number, string, or a blob as `{ "$b64": "..." }`.
public enum Value: Equatable {
    case null
    case int(Int64)
    case double(Double)
    case text(String)
    case blob(Data)

    public init(json: Any) throws {
        switch json {
        case is NSNull: self = .null
        case let s as String: self = .text(s)
        case let d as [String: Any]:
            guard d.count == 1, let b64 = d["$b64"] as? String, let data = Data(base64Encoded: b64) else {
                throw StoreError.invalid("Bad blob value.")
            }
            self = .blob(data)
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() { self = .int(n.boolValue ? 1 : 0) }
            else if CFNumberIsFloatType(n) { self = .double(n.doubleValue) }
            else { self = .int(n.int64Value) }
        default: throw StoreError.invalid("Unsupported parameter type.")
        }
    }

    public var json: Any {
        switch self {
        case .null: return NSNull()
        case .int(let i): return i
        case .double(let d): return d
        case .text(let s): return s
        case .blob(let d): return ["$b64": d.base64EncodedString()]
        }
    }
}

public typealias Row = [String: Value]

public enum StoreError: Error, LocalizedError, Equatable {
    case invalid(String)
    case sqlite(String)
    case transaction(String)
    case io(String)

    public var errorDescription: String? {
        switch self {
        case .invalid(let m), .sqlite(let m), .transaction(let m), .io(let m): return m
        }
    }
}
