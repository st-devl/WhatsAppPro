# Design System Strategy: The Sovereign Interface
 
## 1. Overview & Creative North Star
This design system is built upon the North Star of **"The Sovereign Interface."** Unlike standard SaaS tools that feel like cluttered dashboards, this system treats the user as an executive in a digital command center. We achieve a "High-End Editorial" feel by rejecting the standard "boxed-in" web aesthetic. 
 
The system moves away from rigid grids toward **intentional asymmetry and tonal depth**. We prioritize breathing room (white space) not as a luxury, but as a functional necessity to maintain focus. The visual signature is defined by high-contrast typography and "floating" architectural layers that imply a premium, bespoke experience.
 
---
 
## 2. Colors & Surface Architecture
The palette is rooted in authority and growth. We use **Deep Slate Blue** for structural grounding, **Vibrant Emerald** for brand-aligned success states, and **Gold/Amber** as a high-tier signature.
 
### The "No-Line" Rule
To achieve a premium feel, designers are **strictly prohibited** from using 1px solid borders for sectioning or layout containment. Boundaries must be defined through:
1.  **Background Color Shifts:** Use `surface-container-low` for sidebars and `surface` for the main stage.
2.  **Tonal Transitions:** A `surface-container-lowest` card sitting on a `surface-container` background creates an edge without a line.
 
### Surface Hierarchy & Nesting
Treat the UI as a series of physical layers. We use the Material surface-container tiers to define importance:
*   **Surface (Base):** Your primary canvas.
*   **Surface-Container-Low:** For background utilities or navigation sidebars.
*   **Surface-Container-Lowest:** For primary content cards (elevates them to the foreground).
*   **Surface-Container-Highest:** Reserved for active states or floating pop-overs.
 
### The "Glass & Gradient" Rule
For "Gold Edition" features or high-level status mods, use **Glassmorphism**. Apply `surface-container-lowest` with 70% opacity and a `backdrop-filter: blur(12px)`. To add "soul" to CTAs, use a subtle linear gradient from `primary` (#091426) to `primary-container` (#1e293b) at a 135-degree angle.
 
---
 
## 3. Typography
The system utilizes a dual-font strategy to balance editorial elegance with extreme legibility.
 
*   **Display & Headlines (Manrope):** We use Manrope for its geometric, modern authority. It creates a "fixed" editorial feel that distinguishes this system from generic "Inter-only" dashboards.
*   **Body & Labels (Inter):** We use Inter for its high x-height and exceptional readability at small sizes, crucial for tracking bulk message statuses.
 
**Scale Philosophy:** We avoid "loud" typography. Even the `display-lg` is refined (3.5rem). Hierarchy is achieved through weight and color (e.g., using `on-surface-variant` for metadata) rather than just size.
 
---
 
## 4. Elevation & Depth
Depth in this design system is achieved through **Tonal Layering** rather than heavy drop shadows.
 
*   **The Layering Principle:** Place a `surface-container-lowest` card on a `surface-container-low` section. This creates a soft, natural lift that feels sophisticated and calm.
*   **Ambient Shadows:** When a floating effect is required (e.g., Modals), use a shadow with a 32px blur and 4% opacity. The shadow color must be a tinted version of `on-surface` (#191C1E) to mimic natural light, never pure black.
*   **The "Ghost Border" Fallback:** If accessibility requires a border, use the `outline-variant` token at **20% opacity**. This creates a "suggestion" of a boundary without cluttering the visual field.
 
---
 
## 5. Components
 
### Buttons
*   **Primary:** Slate Blue gradient. Roundedness: `md` (0.75rem).
*   **Success (WhatsApp Connect):** Emerald (#006c49). Used exclusively for "Connected" states or "Start Campaign."
*   **Gold Edition:** Amber/Gold (#F59E0B). Used for upgrades or premium-tier features.
*   **Dangerous (Delete/Reset):** Use `error` (#ba1a1a). These must be "Ghost Style" (outlined) initially, only becoming solid `error` on hover to prevent accidental psychological triggers.
 
### Cards & Lists
*   **No Dividers:** Prohibit the use of horizontal rules (`
`). Use vertical white space (1.5rem to 2rem) or `surface-container` shifts to separate list items.

*   **Status Indicators:** Use high-saturation "Pills." 
    *   *Connected:* `secondary-container` text on `on-secondary-container` background.
    *   *QR Waiting:* `tertiary-container` (Amber) text.
 
### Input Fields
*   **Style:** Minimalist. No bottom border; instead, use a subtle `surface-container-highest` background.
*   **Focus State:** A 2px transition to `secondary` (Emerald) to signal WhatsApp-readiness.
 
---
 
## 6. Do’s and Don’ts
 
### Do:
*   **Embrace Negative Space:** If a screen feels "empty," it is likely working. Do not fill space for the sake of it.
*   **Use Intentional Asymmetry:** Align text to the left but allow imagery or status cards to "float" slightly off-axis for a custom feel.
*   **Contextual Status:** Ensure the "Connected" status is always visible but never "shouting." It should be a constant, calm presence in the navigation.
 
### Don't:
*   **Don't use 100% Black:** Use `primary` or `on-surface` for text to maintain the "Slate" sophisticated tone.
*   **Don't use Standard Shadows:** Avoid the "fuzzy grey box" look. If it doesn't look like glass or paper, the shadow is too heavy.
*   **Don't use Sharp Corners:** Always stick to the `md` (0.75rem) or `lg` (1rem) roundedness scale to maintain the "Professional Corporate" softness.
 
---
 
## 7. Design Tokens (JSON Reference)
 
**Colors:**
- Background: `#f7f9fb`
- Primary: `#091426` (Deep Slate)
- Secondary: `#006c49` (WhatsApp Emerald)
- Tertiary: `#c88000` (Gold Edition Accent)
 
**Roundedness:**
- Card/Button: `0.75rem` (md)
- Modal/Overlay: `1rem` (lg)
 
**Typography:**
- Display: Manrope (Bold)
- Body: Inter (Regular/Medium)