---
code: PLAN.EX-000015
nb: PLAN
type: EX
name: artisan-bakery-website-spec
status: failed
updated: 2026-04-15
summary: Specification for artisan neighborhood bakery website
importance_score: 0
utility_score: 0
usage_count: 0
decay_rate: 0.1
active_page: 1
confidence: 1
last_accessed: 2026-04-14
pinned: 0
source: agent
---

# artisan-bakery-website-spec


# Artisan Bakery Website Specification

## Overview
Create a warm, inviting single-page website for "Hearth & Flour" - an artisan neighborhood bakery specializing in sourdough breads, pastries, and seasonal treats.

## Libraries (CDN)
- Google Fonts: Playfair Display (headings), Lato (body text)
- Font Awesome 6.0 for icons
- No other external dependencies needed

## Color Palette
- Primary: #8B4513 (saddle brown) - warm wood tones
- Secondary: #D2691E (chocolate) - baked goods accent
- Background: #FFF8DC (cornsilk) - cream/warm white
- Text: #2C1810 (dark brown) - rich chocolate text
- Accent: #CD853F (peru) - golden crust tones
- Highlight: #DEB887 (burlywood) - soft pastry color

## Visual Layout

### Header/Navigation
- Fixed transparent-to-solid header on scroll
- Logo: "Hearth & Flour" in elegant serif with wheat icon
- Navigation links: Home, Menu, About, Gallery, Contact
- Mobile hamburger menu for smaller screens

### Hero Section
- Full viewport height (100vh)
- Parallax background effect with warm bakery imagery
- Large centered headline: "Handcrafted Breads & Pastries"
- Subheadline: "Baked fresh daily in the heart of the neighborhood"
- CTA button: "View Our Menu" with smooth scroll
- Animated flour particles floating gently

### Featured Products Section
- Grid of 6 featured items with hover effects
- Each card shows: image placeholder, name, description, price
- Items: Sourdough Loaf ($8), Croissants ($4), Pain au Chocolat ($5), Baguette ($3), Cinnamon Rolls ($6), Seasonal Fruit Tart ($12)
- Subtle shadow and scale animation on hover

### About Section
- Two-column layout (text + image placeholder)
- Story about family recipes, local ingredients, wood-fired oven
- Values: sustainability, community, tradition
- Stats counter animation: 15 years, 50+ daily customers, 20 bread varieties

### Menu Section
- Tabbed interface: Breads | Pastries | Cakes | Beverages
- Each tab shows categorized items with prices
- Clean typography with subtle dividers
- "Order Online" button linking to contact section

### Gallery Section
- Masonry-style grid of 12 image placeholders
- Lightbox modal on click for full-size view
- Smooth transitions and zoom effects

### Testimonials Section
- Carousel of 3 customer reviews
- Star ratings, names, and quotes
- Auto-rotate with manual navigation

### Contact/Footer Section
- Two columns: contact info + embedded map placeholder
- Hours of operation displayed prominently
- Social media icons (Facebook, Instagram)
- Newsletter signup form
- Copyright and simple footer links

## Interactions & Animations
- Smooth scroll for anchor links
- Fade-in animations on scroll using Intersection Observer
- Button hover effects with color transitions
- Mobile menu slide-in animation
- Flour particle animation in hero (canvas-based, lightweight)
- Counter animation for stats section

## Responsive Breakpoints
- Desktop: 1200px+
- Tablet: 768px - 1199px
- Mobile: < 768px

## Typography
- Headings: Playfair Display, elegant serif
- Body: Lato, clean sans-serif
- Font sizes: responsive using rem units
- Line heights: generous for readability (1.6-1.8)

