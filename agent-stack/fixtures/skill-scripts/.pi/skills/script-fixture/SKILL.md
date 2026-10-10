---
name: script-fixture
description: Test fixture, not shipped. A minimal skill with a scripts/ directory for the pi skill-script permission test.
---

# Script Fixture

Test fixture, not shipped. This skill exists only to give the script-permission
test a real loaded skill with a real `scripts/` directory. It lives under
`agent-stack/fixtures/`, so `discoverSkills` finds it only when the caller passes
the fixture root as the cwd. No agent loads it in normal use.
