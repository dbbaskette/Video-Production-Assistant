# UX consistency, accessibility, and recovery implementation plan

1. Add shared nav/layer tokens, namespace brand-generation progress, and establish a global reduced-motion contract.
2. Add reusable loading/error rails with accessible live regions and retry behavior.
3. Apply recovery states to Dashboard, projects, Brands, Voices, and Setup; preserve stale health results and show their age.
4. Correct command-palette combobox/listbox semantics, focus trapping/restoration, and partial-query recovery.
5. Move unsaved-change confirmation to the in-app dialog service and add focus management to remaining dialogs.
6. Add focused accessibility/recovery tests, run the full web suite and production build, then publish and merge #85.

- [x] 1
- [x] 2
- [x] 3
- [x] 4
- [x] 5
- [x] 6

## Review focus

- Keyboard focus must never escape an open modal or disappear after close.
- A failed refresh must not label cached health data as fresh.
- Retry must preserve typed form data and existing successful query data.
- CSS changes must not alter the project-overview pipeline or narrow workspace geometry unexpectedly.
