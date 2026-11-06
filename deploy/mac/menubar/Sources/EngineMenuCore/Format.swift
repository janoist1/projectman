import Foundation

public enum Format {
    public static func number(_ value: Double, locale: Locale = L10n.locale) -> String {
        let formatter = NumberFormatter(); formatter.locale = locale
        formatter.maximumFractionDigits = 1
        return formatter.string(from: NSNumber(value: value)) ?? String(value)
    }
    public static func gb(_ bytes: Double) -> String { L10n.text(.gigabytes, number(bytes / 1_000_000_000)) }
    public static func relative(_ timestamp: String?, now: Date) -> Localized {
        let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let timestamp, let date = parser.date(from: timestamp) ?? ISO8601DateFormatter().date(from: timestamp) else { return Localized(.now) }
        let minutes = max(0, Int(now.timeIntervalSince(date) / 60))
        if minutes < 1 { return Localized(.now) }
        if minutes < 60 { return Localized(.minutes, String(minutes)) }
        if minutes < 1440 { return Localized(.hours, String(minutes / 60)) }
        return Localized(.days, String(minutes / 1440))
    }
}
