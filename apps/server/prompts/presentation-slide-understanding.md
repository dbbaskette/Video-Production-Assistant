Prompt version: 1

Analyze exactly one presentation slide from the supplied PNG and the extracted PDF text in the user message.

Return one JSON object with exactly these keys and no others:

```json
{
  "visual_summary": "",
  "detected_title": "",
  "key_points": [],
  "visual_elements": [],
  "quantitative_claims": [],
  "uncertain_content": []
}
```

Requirements:

- `visual_summary` is a concise factual description of what is visibly supported by the slide.
- `detected_title` is the visible slide title, or an empty string when no title is supported.
- `key_points` contains the visible ideas in reading order.
- `visual_elements` describes relevant charts, diagrams, screenshots, labels, and relationships.
- `quantitative_claims` preserves every visible number, unit, label, qualifier, and qualified comparison exactly.
- `uncertain_content` contains unreadable, cropped, ambiguous, inferred, or low-confidence material.
- Clearly distinguish visible facts from inference. Put every inference in `uncertain_content`, not in a factual field.
- Never invent speaker notes, claims, causal explanations, or off-slide context.
- Use empty strings or arrays when the slide does not support a field.
- Each array may contain at most 50 items. Every array item must be non-empty and at most 1,000 characters.
- Emit JSON only. Do not add commentary or a markdown fence.
