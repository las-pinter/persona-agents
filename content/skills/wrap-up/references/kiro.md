# Wrap-up on Kiro CLI

The session id is in your system context, on the line `Session id: <id>`.

## Steps 1 and 2

1. Get this session's entry path. Run this with the shell tool:

   ```sh
   node --experimental-strip-types --no-warnings {{PERSONA_AGENTS_KIRO_ROOT}}/platforms/kiro/scripts/session-log.ts path --session=<id>
   ```

   The path is this session's existing entry (today or yesterday) or a new
   one. Each session has its own file, so parallel sessions never collide. The
   script creates the day folder.

2. Write the whole entry to that path with the `fs_write` tool, in the format
   below. The notes folder is outside the repository, and the companion's
   permission rules allow writes there. When the file exists, read it first and
   write the merged entry: a second wrap-up replaces the first.

## Then

Continue with steps 3 to 5 of the shared skill: update each task notes
file this session worked on, update the project notes when a lasting rule or
fact was found, and tell the owner the entry path in one line.

## Limit

The SessionEnd safety net runs only in an interactive session. A headless or
scripted run gets no automatic entry, so run the wrap-up there.
