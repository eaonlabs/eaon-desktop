#include <metal_stdlib>
using namespace metal;

// The landing screen's glass, drawn by LensRenderer into a transparent Metal
// view laid over the screen:
//
// - the marbles, into a texture of their own (`scene`);
// - that texture, copied onto the screen;
// - the lens on top. It refracts what's behind it: the paper, the layers of
//   UI behind the glass (rendered to textures by BackdropTexture.swift) and
//   the marbles, so it can look anywhere on them.
//
// Positions are in points, origin at the view's top-left corner, y down.
// Keep the structs in step with the Swift ones in LensRenderer.swift.

struct LensUniforms {
    /// The paper under everything: rgb, gamma encoded; a = 1.
    float4 paper;
    /// The crescent of light: its inner (cyan) edge, core (blue) and outer (violet) edge.
    float4 crescentInner;
    float4 crescentCore;
    float4 crescentOuter;
    /// The view's size; the marble texture covers it exactly.
    float2 viewSize;
    float2 center;
    float radius;
    /// How far the line of sight bends where the glass is steepest, in radii.
    float refraction;
    /// How much the middle magnifies.
    float magnification;
    /// The width of the bevel round the edge, as a fraction of the radius.
    float rimWidth;
    /// The bevel's squircle exponent: 2 is round, higher starts flatter.
    float rimCurve;
    /// How much further blue bends than green, and red less, as a fraction.
    float dispersion;
    /// The rim's specular line and pale lip, 0…1 and a little past.
    float highlight;
    /// The crescent's strength, 0…1.
    float crescent;
    /// 0 gathers the light into a haze in the middle; 1 spreads it into a
    /// band round the lower rim.
    float spread;
    /// The whole lens, shadow included (for crossfades).
    float opacity;
    float pixelsPerPoint;
    /// The paper's film grain, so the glass matches the paper round it.
    float grain;
    /// 1 in dark mode.
    float dark;
    int layerCount;
};

/// One layer of UI behind the glass, drawn into its own texture.
struct BackdropLayer {
    /// Where the texture sits on screen: x, y, width, height in points.
    float4 rect;
    float opacity;
    /// Extra mip level, to blur the layer as the screen blurs it.
    float lod;
    float2 unused;
};

struct Marble {
    float2 center;
    float radius;
    /// Which picture is inside, a slice of the art texture.
    float art;
    /// How far the picture is turned, in radians.
    float spin;
    float alpha;
    /// How strongly the marble bends its picture: faces need to stay faces.
    float strength;
    float unused;
};

struct MarbleUniforms {
    /// width, height (points), pixels per point, dispersion.
    float4 view;
    /// The light the marbles catch, as `highlight` above.
    float highlight;
    float dark;
    float2 unused;
};

struct LensVertexOut {
    float4 position [[position]];
};

struct MarbleVertexOut {
    float4 position [[position]];
    /// Where in the marble: its radius is 1.
    float2 local;
    float radiusPixels [[flat]];
    float radiusPoints [[flat]];
    float art [[flat]];
    float spin [[flat]];
    float alpha [[flat]];
    float strength [[flat]];
};

namespace {

/// The same grain as `paperGrain` in Glass.metal, cell for cell.
float hash21(float2 p) {
    uint2 q = uint2(int2(p) + int2(8192)) * uint2(1597334673u, 3812015801u);
    uint n = (q.x ^ q.y) * 1597334673u;
    return float(n) * (1.0 / 4294967295.0);
}

/// How steeply the glass falls away at `r` (0 at the centre, 1 at the edge),
/// as -dh/dr. The height profile is a low dome, which magnifies the middle
/// evenly, with a squircle bevel round its edge: h = w (1 - t^p)^(1/p) across
/// the outer `rimWidth`, p = `rimCurve`. The bevel starts flat and steepens
/// smoothly, which is what makes the image swell into a wide smear before it
/// folds over; a round bevel (p = 2) folds it along a hard line.
float lensSlope(float r, float domeSlope, float rimWidth, float rimCurve) {
    float slope = domeSlope * r;
    float w = max(rimWidth, 0.01);
    float t = (r - (1.0 - w)) / w;
    if (t > 0.0) {
        t = min(t, 0.9995);
        float p = max(rimCurve, 1.5);
        float tp1 = pow(t, p - 1.0);
        slope += tp1 / pow(1.0 - tp1 * t, (p - 1.0) / p);
    }
    return slope;
}

/// The surface normal of a lens at `r` along `dir`, from its height profile.
float3 lensNormal(float r, float2 dir, float refraction, float magnification, float rimWidth, float rimCurve) {
    // Small slopes bend the view by about refraction · slope, so this dome
    // slope magnifies the middle by `magnification`.
    float domeSlope = (1.0 - 1.0 / max(magnification, 1.0)) / max(refraction, 0.0001);
    float slope = lensSlope(min(r, 1.0), domeSlope, rimWidth, rimCurve);
    return normalize(float3(dir * slope, 1.0));
}

/// What's seen at `q` (points) with no glass in the way: the paper, the UI
/// layers over it, and the marbles over those.
float3 behind(float2 q,
              constant LensUniforms &u,
              constant BackdropLayer *layer,
              array<texture2d<half>, 4> layers,
              texture2d<half> scene,
              sampler layerSampler,
              sampler sceneSampler) {
    float3 c = u.paper.rgb;
    for (int i = 0; i < u.layerCount; i++) {
        float4 rect = layer[i].rect;
        half4 s = layers[i].sample(layerSampler, (q - rect.xy) / rect.zw, bias(layer[i].lod));
        c = c * (1.0 - float(s.a) * layer[i].opacity) + float3(s.rgb) * layer[i].opacity;
    }
    half4 m = scene.sample(sceneSampler, q / u.viewSize);
    return c * (1.0 - float(m.a)) + float3(m.rgb);
}

/// The light a rim catches: a thin specular line just inside the edge,
/// bright toward the upper left and fainter opposite, plus a pale lip where
/// the bevel turns steeply away from the viewer.
/// `edge` is the distance in from the rim and `lineWidth` the line's
/// width, both in points.
float rimLight(float2 dir, float3 normal, float edge, float lineWidth) {
    float line = exp(-pow((edge - lineWidth) / lineWidth, 2.0));
    float facing = dot(dir, normalize(float2(-0.55, -0.83)));
    float specular = line * (smoothstep(-0.15, 0.85, facing) + 0.35 * smoothstep(-0.15, 0.85, -facing));
    // The lip is brighter on the side toward the light too.
    float lip = pow(1.0 - normal.z, 2.2) * 0.22 * (0.65 + 0.35 * facing);
    return specular * 0.85 + lip;
}

} // namespace

// MARK: - The lens

/// A quad over the lens and its shadow. `rect` is (minX, minY, maxX, maxY) in clip space.
vertex LensVertexOut lensVertex(uint vid [[vertex_id]], constant float4 &rect [[buffer(0)]]) {
    float2 corner = float2(float(vid & 1u), float(vid >> 1u));
    LensVertexOut out;
    out.position = float4(mix(rect.xy, rect.zw, corner), 0.0, 1.0);
    return out;
}

/// 1. Shape: a circle SDF; `r` is the distance from the centre in radii.
/// 2. Surface: the height profile's slope gives the normal, n = (dir · slope, 1).
/// 3. Refraction: what's behind is looked up `refraction` radii along the
///    normal's tilt, toward the centre. The dome magnifies the middle; in the
///    bevel the offset grows past the point's own distance from the centre,
///    so the rim shows what's under the middle again, upside down.
/// 4. Dispersion: red, green and blue are looked up separately, red bending
///    by (1 - dispersion) and blue by (1 + dispersion) of green's amount.
/// 5. Light: the crescent and haze, the rim's specular line and lip, a
///    hairline at the edge, and a soft shadow just outside, a little below.
fragment half4 lensFragment(LensVertexOut in [[stage_in]],
                            constant LensUniforms &u [[buffer(0)]],
                            constant BackdropLayer *layer [[buffer(1)]],
                            array<texture2d<half>, 4> layers [[texture(0)]],
                            texture2d<half> scene [[texture(4)]],
                            sampler layerSampler [[sampler(0)]],
                            sampler sceneSampler [[sampler(1)]]) {
    float2 p = in.position.xy / u.pixelsPerPoint;
    float R = u.radius;
    float2 d = p - u.center;
    float dist = length(d);
    float r = dist / R;
    bool dark = u.dark > 0.5;

    // The soft shadow: a disc a little below the glass, blurred over about
    // a fifth of the radius (more for a small orb, so it still reads).
    float shadowR = length(p - (u.center + float2(0.0, R * 0.07 + 2.0))) / R;
    float blur = max(0.2, 10.0 / R);
    float shadow = (1.0 - smoothstep(1.0 - blur * 0.6, 1.0 + blur, shadowR)) * (dark ? 0.3 : 0.06);

    float coverage = saturate((R - dist) * u.pixelsPerPoint + 0.5);
    if (coverage <= 0.0) return half4(0.0h, 0.0h, 0.0h, half(shadow * u.opacity));

    float2 dir = dist > 0.0001 ? d / dist : float2(0.0);
    float3 normal = lensNormal(r, dir, u.refraction, u.magnification, u.rimWidth, u.rimCurve);
    float2 bend = normal.xy * R * u.refraction;
    // Colours part only in the bevel, most where the image swells. The
    // middle stays clean, as in the reference; in the steepest part, where
    // the bend is largest, full dispersion would print the folded text three times.
    float bevel = (r - (1.0 - u.rimWidth)) / max(u.rimWidth, 0.01);
    float dispersion = u.dispersion * smoothstep(0.0, 0.4, bevel) * (1.0 - 0.85 * smoothstep(0.6, 0.95, bevel));

    float3 c;
    c.r = behind(p - bend * (1.0 - dispersion), u, layer, layers, scene, layerSampler, sceneSampler).r;
    c.g = behind(p - bend, u, layer, layers, scene, layerSampler, sceneSampler).g;
    c.b = behind(p - bend * (1.0 + dispersion), u, layer, layers, scene, layerSampler, sceneSampler).b;

    // The grain belongs to the glass's own pixels: magnified, it would smear.
    c += (hash21(floor(p * 3.0)) - 0.5) * u.grain;
    // Clear glass is a touch lighter than what it sits on.
    c = mix(c, float3(1.0), dark ? 0.025 : 0.04);

    // The crescent: light gathering in the glass while it's held. At first
    // a pale haze in the middle; as the glass lifts, a band of cyan, blue
    // and violet pooled in its lower rim.
    if (u.crescent > 0.001) {
        float s = saturate(u.spread);
        float bandR = mix(0.0, 0.72, s);
        float width = mix(0.5, 0.12, s);
        // The haze gathers high in the glass, where a dome resting on the
        // bottom edge shows; as it spreads into the band it centres.
        float2 hazeCenter = float2(0.0, -0.5 * (1.0 - s));
        float t = (length(d / R - hazeCenter) - bandR) / width;
        // Weighted by height, not direction, near the centre, where the
        // direction jumps and would draw a wedge. The band thins and fades
        // as it climbs the sides.
        float below = d.y / (R * max(r, 0.45));
        float lower = mix(1.0, smoothstep(-0.3, 0.6, below), s);
        // Blue at the core, with a cyan ribbon along its inner edge that
        // carries further than the violet outside it.
        float core = t < 0.0 ? exp(-t * t * 0.8) : exp(-t * t * 1.6);
        // A faint violet fringe just outside the band.
        float halo = exp(-pow((t - 1.3) / 0.6, 2.0)) * 0.16;
        float3 band = t < 0.0 ? mix(u.crescentCore.rgb, u.crescentInner.rgb, saturate(-t * 1.6))
                              : mix(u.crescentCore.rgb, u.crescentOuter.rgb, saturate(t * 0.8));
        // Gathered in the middle, the light is a pale haze of the outer colour.
        float3 haze = mix(u.crescentOuter.rgb, float3(1.0), 0.45);
        float3 light = mix(haze, band, smoothstep(0.0, 0.6, s));
        float strength = max(core, halo) * lower * mix(0.5, 1.0, s);
        c = mix(c, light, saturate(strength * u.crescent));
    }

    // Light on the rim. The specular line is a few points wide whatever the
    // lens's size, a little wider on a big lens.
    float edge = (1.0 - r) * R;
    float lineWidth = clamp(R * 0.014, 0.9, 3.0);
    c = mix(c, float3(1.0), saturate(rimLight(dir, normal, edge, lineWidth) * u.highlight));
    // A hairline at the very edge, so the glass reads on plain paper.
    float hair = exp(-pow((edge - 0.35) / 0.45, 2.0)) * 0.3;
    c = mix(c, dark ? float3(1.0) : c * 0.78, hair * saturate(u.highlight));

    float alpha = coverage + shadow * (1.0 - coverage);
    return half4(half3(c * coverage * u.opacity), half(alpha * u.opacity));
}

// MARK: - Marbles

/// One quad per marble, a pixel or so larger than it for the antialiased edge.
vertex MarbleVertexOut marbleVertex(uint vid [[vertex_id]],
                                    uint iid [[instance_id]],
                                    constant Marble *marbles [[buffer(0)]],
                                    constant MarbleUniforms &u [[buffer(1)]]) {
    Marble m = marbles[iid];
    float radiusPixels = max(m.radius * u.view.z, 0.5);
    float pad = 1.0 + 1.5 / radiusPixels;
    float2 local = (float2(float(vid & 1u), float(vid >> 1u)) * 2.0 - 1.0) * pad;
    float2 p = m.center + local * m.radius;
    MarbleVertexOut out;
    out.position = float4(p.x / u.view.x * 2.0 - 1.0, 1.0 - p.y / u.view.y * 2.0, 0.0, 1.0);
    out.local = local;
    out.radiusPixels = radiusPixels;
    out.radiusPoints = m.radius;
    out.art = m.art;
    out.spin = m.spin;
    out.alpha = m.alpha;
    out.strength = m.strength;
    return out;
}

/// A glass marble with a picture inside: the same optics as the lens, made
/// stronger, so the picture swells in the middle and folds over at the rim
/// with coloured edges, and lit the same way.
fragment half4 marbleFragment(MarbleVertexOut in [[stage_in]],
                              constant MarbleUniforms &u [[buffer(1)]],
                              texture2d_array<half> art [[texture(0)]],
                              sampler artSampler [[sampler(0)]]) {
    float r = length(in.local);
    float coverage = saturate((1.0 - r) * in.radiusPixels + 0.5);
    if (coverage <= 0.0) return half4(0.0h);

    float2 dir = r > 0.0001 ? in.local / r : float2(0.0);
    float strength = in.strength;
    float k = 1.6 * strength;
    float3 normal = lensNormal(r, dir, k, mix(1.0, 1.35, strength), 0.55, 2.6);
    float2 bend = normal.xy * k;
    float dispersion = u.view.w * 1.6;

    float cs = cos(in.spin), sn = sin(in.spin);
    float2x2 turn = float2x2(float2(cs, sn), float2(-sn, cs));
    uint slice = uint(in.art + 0.5);
    // The picture fills a little more than the marble shows, so its rim
    // folds over picture, not the edge of the cell.
    float zoom = 0.82;
    float2 qr = turn * (in.local - bend * (1.0 - dispersion)) * zoom;
    float2 qg = turn * (in.local - bend) * zoom;
    float2 qb = turn * (in.local - bend * (1.0 + dispersion)) * zoom;
    float3 c = float3(art.sample(artSampler, qr * 0.5 + 0.5, slice).r,
                      art.sample(artSampler, qg * 0.5 + 0.5, slice).g,
                      art.sample(artSampler, qb * 0.5 + 0.5, slice).b);

    float edge = (1.0 - r) * in.radiusPoints;
    float lineWidth = clamp(in.radiusPoints * 0.05, 0.6, 1.6);
    c = mix(c, float3(1.0), saturate(rimLight(dir, normal, edge, lineWidth) * u.highlight * 0.8));
    // A soft dark edge gives each marble its outline in the pile.
    float hair = exp(-pow(edge / max(lineWidth * 0.8, 0.5), 2.0)) * 0.35;
    c = mix(c, c * 0.55, hair);

    float a = coverage * in.alpha;
    return half4(half3(c * a), half(a));
}

// MARK: - Copying the marbles onto the screen

vertex LensVertexOut fullscreenVertex(uint vid [[vertex_id]]) {
    // One triangle that covers the screen.
    float2 corner = float2(float((vid << 1u) & 2u), float(vid & 2u));
    LensVertexOut out;
    out.position = float4(corner * 2.0 - 1.0, 0.0, 1.0);
    return out;
}

fragment half4 sceneFragment(LensVertexOut in [[stage_in]], texture2d<half> scene [[texture(0)]]) {
    return scene.read(uint2(in.position.xy));
}
