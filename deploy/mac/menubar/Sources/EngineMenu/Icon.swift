import AppKit
import EngineMenuCore

enum StatusIcon {
    static func image(_ kind: IconKind, phase: Double = 0) -> NSImage {
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { rect in
            let context = NSGraphicsContext.current!.cgContext
            context.scaleBy(x: rect.width / 48, y: rect.height / 48)
            let faint = kind == .stopped || kind == .unconfigured
            NSColor.black.withAlphaComponent(faint ? 0.45 : 1).set()
            let filled = kind == .running || kind == .noCloud
            let tile = filled ? NSRect(x: 0, y: 0, width: 48, height: 48) : NSRect(x: 1.2, y: 1.2, width: 45.6, height: 45.6)
            let outline = NSBezierPath(roundedRect: tile, xRadius: 10.5, yRadius: 10.5)
            outline.lineWidth = 2.4
            if kind == .running || kind == .noCloud { outline.fill() }
            else {
                if kind == .unconfigured { outline.setLineDash([4, 3], count: 2, phase: 0) }
                outline.stroke()
            }
            if kind == .running || kind == .noCloud { context.setBlendMode(.destinationOut) }
            if kind != .unconfigured {
                for (index, height) in [12.0, 7.5, 4.0].enumerated() {
                    let wave = kind == .busy ? sin(phase + Double(index)) * 2.5 : 0
                    let line = NSBezierPath(); line.lineWidth = 2.4; line.lineCapStyle = .round
                    let x = 18.5 + Double(index) * 5.5
                    line.move(to: NSPoint(x: x, y: 30)); line.line(to: NSPoint(x: x, y: 30 - height - wave)); line.stroke()
                }
            }
            if kind == .noCloud || kind == .warning {
                context.setBlendMode(.destinationOut)
                NSBezierPath(ovalIn: NSRect(x: 28, y: 28, width: 22, height: 22)).fill()
                context.setBlendMode(.normal)
                NSBezierPath(ovalIn: NSRect(x: 32.5, y: 32.5, width: 13, height: 13)).fill()
            }
            return true
        }
        image.isTemplate = true
        return image
    }
}
