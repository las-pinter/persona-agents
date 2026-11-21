---
type: regex
target: last_message
match: contains
flags: i
pattern: '## Skills loaded[\s\S]{0,400}(rust-quality-gate|rust-skills|rust-best-practices|rust-async-patterns)'
---

The report has a `## Skills loaded` section naming a Rust skill.
