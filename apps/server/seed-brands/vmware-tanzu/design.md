---
version: alpha
name: VMware Tanzu
description: >-
  Enterprise cloud infrastructure and virtualization platform presentation system with accessible
  design tokens
colors:
  primary: '#1B1D36'
  secondary: '#005C8A'
  tertiary: '#CC092F'
  neutral: '#FFFFFF'
  on-surface: '#000000'
  success: '#23800A'
  warning: '#E68C28'
typography:
  headline-lg:
    fontFamily: Arial
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.2
  headline-md:
    fontFamily: Arial
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.3
  body-lg:
    fontFamily: Arial
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.5
  body-md:
    fontFamily: Arial
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
  body-sm:
    fontFamily: Arial
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  label-md:
    fontFamily: Arial
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1.4
rounded:
  sm: 4px
  md: 8px
  lg: 16px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  xxl: 48px
components:
  button-primary:
    backgroundColor: '{colors.primary}'
    textColor: '{colors.neutral}'
    rounded: '{rounded.sm}'
    padding: 12px 24px
    typography: label-md
  card:
    backgroundColor: '{colors.neutral}'
    textColor: '{colors.on-surface}'
    rounded: '{rounded.md}'
  alert-error:
    backgroundColor: '#CC092F'
    textColor: '{colors.neutral}'
    rounded: '{rounded.sm}'
  badge-success:
    backgroundColor: '{colors.success}'
    textColor: '{colors.neutral}'
    rounded: '{rounded.full}'
  badge-warning:
    backgroundColor: '{colors.warning}'
    textColor: '{colors.on-surface}'
    rounded: '{rounded.full}'
  link:
    textColor: '{colors.secondary}'
    typography: body-md
vpa:
  voice:
    tone: Professional, innovative, secure
    avoid:
      - jargon-heavy
      - overly complex
      - ambiguous
  audio:
    music_mood: null
    sonic_logo: null
  logo:
    primary: assets/Tanzu_UpdatedBug_2024.png
    mono: null
    safe_zone_ratio: 0.25
  lower_thirds:
    template: bar-left-accent
    bg: '{colors.primary}'
    fg: '{colors.neutral}'
  taglines:
    - The enterprise workload engine to optimize your private cloud
---

## Overview

The VMware Tanzu design system embodies a professional and secure identity tailored for enterprise cloud infrastructure. Our visual language prioritizes clarity and innovation, ensuring users feel confident navigating complex virtualization platforms. This presentation system establishes a consistent foundation that reinforces trust while enabling seamless scalability across digital experiences. We avoid ambiguity in favor of direct communication, aligning with the brand’s role as an engine for optimizing private clouds.

## Colors

The palette centers on `primary` (#1B1D36), a deep navy that anchors headlines and primary actions to convey stability. We use `secondary` (#005C8A) for interactive elements like links to maintain brand recognition without overwhelming the interface. Critical status indicators rely on `tertiary` (#CC092F) for errors and alerts, while `success` (#23800A) and `warning` (#E68C28) provide immediate visual feedback. All text combinations utilize `neutral` (#FFFFFF) backgrounds with `on-surface` (#000000) text to ensure WCAG AA contrast compliance across the platform.

## Typography

Typography relies on a robust Arial typeface hierarchy designed for readability at scale and system consistency. `headline-lg` (36px) and `headline-md` (28px) establish clear page structure with bold weights, while body text in `body-lg`, `body-md`, and `body-sm` ensures content remains legible across devices. We apply `label-md` for buttons and form controls to distinguish actionable items from informational text. This consistent pairing eliminates ambiguity and supports the brand's secure, professional tone.

## Layout

Our spacing system utilizes a modular scale ranging from `xs` (4px) to `xxl` (48px) to create rhythm and breathing room within layouts. This structured approach prevents clutter, allowing users to focus on critical workload data without visual distraction. We apply these tokens consistently across margins and padding to maintain alignment and balance throughout the interface, ensuring content flows logically from one section to the next.

## Shapes

Shape language balances professionalism with modern softness through progressive corner radii defined in `rounded`. `sm` (4px) defines sharp primary buttons for precision, while `md` (8px) frames content cards to soften edges without losing structure. We reserve `full` (9999px) exclusively for status badges and tags to create distinct pill-shaped indicators that stand out against the interface background. This strategy guides user attention toward critical system states immediately.

## Components

Core components are built using standardized tokens to ensure reliability during rapid deployment. The `button-primary` utilizes the dark primary color with neutral text for high-impact calls to action, while `card` elements use white backgrounds to separate content areas. Status indicators like `alert-error` and `badge-success` leverage specific semantic colors to communicate system state instantly, reducing cognitive load for operators managing enterprise workloads. Links utilize `secondary` (#005C8A) text with standard body sizing to signal interactivity clearly.

## Do's and Don'ts

Do prioritize clarity when presenting complex infrastructure data; use `headline-md` or larger for key metrics to ensure hierarchy is understood immediately. Ensure all interactive elements adhere to the defined color contrast ratios for accessibility, particularly on light backgrounds. Never deviate from the established primary blue (#005C8A) for links, as this is a critical navigational cue for users. Avoid using ambiguous colors outside of the defined semantic palette (success/warning/error), and never compromise readability by placing light text on dark surfaces without explicit permission.

