---
type: concept
aliases: []
definition:
requires: []
---

# {{title}}

## Taught in

```base
filters:
  and:
    - file.hasLink(this.file)
    - file.name != "README"
    - not:
        - file.path.contains("/_")
views:
  - type: table
    name: Lessons
    order:
      - file.name
      - file.folder
```

## Notes for instructors
