ROGUEPROOF — BRAND ASSET PACKAGE
================================
Brand: RogueProof. Scenario: Agent Zero.
Tagline: "Break your AI agents before the real world does."
Attribution: "Built on Otari by Mozilla.ai".

THE MARK: ZERO EYE
A thick zero (Agent Zero) with an off-centre pupil: an agent glancing sideways.
On light grounds it sits on a tilted yellow tag.

PALETTE (ONLY THREE COLOURS)
Ink:    #111111
Paper:  #FFFFFF
Yellow: #FFC83D
Light tiles: ink zero with a paper interior on the yellow tag, paper ground.
Dark tiles: yellow zero and pupil on ink, no tag.
Transparent flat marks: ink for light surfaces, paper or yellow for dark surfaces.
Red and green are not brand colours: the dashboard reserves them for a denied
action and a rescued fallback.

TYPEFACE / OUTLINES
Wordmark: Inter ExtraBold (28pt optical size), "RogueProof", tracking -1.2% em,
cap height 150 on the 512 lockup. Tagline on the social card: Inter Medium.
Inter is licensed under the SIL Open Font License. All lettering is converted
to paths with fontTools; no kerning pairs applied. No font files, SVG text
elements, external fonts or dependencies shipped.

COMMON GEOMETRY
One 512 x 512 master square for every mark. App tile radius: 112 / 512.
Ring: ellipse centred (256,256).
App and flat mark: rx 104, ry 132 (centreline), stroke 52; pupil r 34 at (282,284).
  Tag: 102,184 383,148 423,242 392,346 120,369 with a 16-unit round join.
Favicon: rx 120, ry 150, stroke 68; pupil r 44 at (286,290). The favicon mark is
  larger and heavier than the app mark so the ring holds at 16px.
  Tag: 79,173 402,132 448,240 412,360 100,386.
Wordmark lockup: mark at translate(-58 51.2) scale(0.8), baseline y 331.

FOLDERS
app-icon/: 512px tile SVGs, 512px raster and 1024px @2x raster on both palettes.
favicon/: theme-aware favicon.svg, multipage dark favicon.ico (16,32,48), static
  dark/light 16/32/48/64 SVGs and 1x/2x PNGs.
flat-mark/: ring and pupil only on transparency, in ink (mark-light), paper
  (mark-dark) and yellow (mark-amber), each 512px/1024px PNG.
wordmark/: mark + outlined "RogueProof" lockups on transparent grounds.
  Suffixless and @1x PNG are native 1499x512; @2x PNG is 2998x1024.
  wordmark-light is for light surfaces (it carries the yellow tag and a paper
  ring interior); wordmark-dark is for dark surfaces.
social/: GitHub social artwork in SVG and 1280x640 PNG, with the tagline.
pwa/: 192/512 dark tiles, 512 maskable tile (full bleed, mark at 72%),
  180 Apple touch icon (full bleed, no rounded corners).

NOTES
- Static SVGs contain only rects, ellipses, circles, polygons and paths: no text,
  embedded rasters, filters or gradients. The theme-aware favicon.svg adds a
  style block for prefers-color-scheme switching.
- Readability at 16px is judged by eye, not machine-checked.
- The dashboard references the favicon, the Apple touch icon and the social
  card (app/layout.tsx) and favicon/favicon-64-light.svg (the zero on its yellow
  tag) in its header.
