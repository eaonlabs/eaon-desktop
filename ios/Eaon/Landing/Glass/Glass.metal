#include <metal_stdlib>
#include <SwiftUI/SwiftUI_Metal.h>
using namespace metal;

// SwiftUI shaders for the landing screen. Swift calls them through
// GlassShaders.swift. (The glass itself is drawn in Metal: Lens.metal.)

namespace {

float hash21(float2 p) {
    uint2 q = uint2(int2(p) + int2(8192)) * uint2(1597334673u, 3812015801u);
    uint n = (q.x ^ q.y) * 1597334673u;
    return float(n) * (1.0 / 4294967295.0);
}

} // namespace

/// Fine, static film grain over a flat fill, like the app icon's tile.
[[ stitchable ]] half4 paperGrain(float2 position, half4 color, float amount) {
    // Three cells to the point: one per pixel on a 3x screen.
    float n = hash21(floor(position * 3.0)) - 0.5;
    return half4(color.rgb + half(n * amount) * color.a, color.a);
}
