---
name: edge-case-checklist
description: Universal checklist of edge cases to verify before declaring test coverage complete.
---

# Skill: Edge Case Checklist

## When to Use
When writing or reviewing tests — run through this before declaring coverage complete.

## Universal Checks

**Values:**
- [ ] Zero / empty / null / undefined
- [ ] Negative numbers
- [ ] Maximum and minimum boundary values (off-by-one!)
- [ ] Very large inputs
- [ ] Duplicate values

**Strings:**
- [ ] Empty string
- [ ] Whitespace only
- [ ] Special characters and unicode
- [ ] Extremely long strings

**Collections:**
- [ ] Empty collection
- [ ] Single element
- [ ] Duplicate elements
- [ ] Unsorted / unexpected order

**Control flow:**
- [ ] All branches taken (if/else, switch)
- [ ] Loops with zero iterations
- [ ] Loops with one iteration
- [ ] Early exit / return paths

**Errors:**
- [ ] Invalid input types
- [ ] Missing required fields
- [ ] Network/IO failure
- [ ] Timeout
- [ ] Partial failure (some operations succeed, some fail)

**Concurrency (if applicable):**
- [ ] Race conditions
- [ ] Deadlocks
- [ ] Out-of-order execution

## Output
List uncovered edge cases grouped by category. Example:
> **Values:** null input not tested, negative number not tested
> **Errors:** timeout path has no test

## Example (partial)
For a function `divide(a, b)`:
- [ ] `b = 0` → division by zero
- [ ] `a = 0` → returns 0
- [ ] Both negative → correct sign
- [ ] Very large floats → precision loss
