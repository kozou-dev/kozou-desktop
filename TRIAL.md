# Trying kozou Desktop — what feedback helps

Thanks for trialing the semantic map. It is an early, experimental build
(`v0.4.0-alpha.1`), and we are trying to learn one thing: **does seeing your
database's compiled semantics — comments, `@ai`/`@policy` notes, views, and
relationships — as a visual map actually help you in real work?**

Please run it against **your real databases** (two or more, ideally across
different projects) for a couple of weeks, the way you normally work. There is
nothing to configure beyond adding your connection profiles.

A least-privilege **read-only** connection role is all you need. Introspection
runs inside a `READ ONLY` transaction, and so does row browsing — and so does
every read the editor makes. Browsing is **off for every profile** until you turn
it on from that database's own row and approve a system dialog; the level is shown
either way, and editing a profile's connection turns browsing back off so the next
attempt asks again. That row is the bar above the map while the database is
selected from the rail, and its card in the **All databases** view — one database
at a time in the first, all of them side by side in the second. So a grant on a
database you are not looking at is not on screen: the rail says nothing about
levels, and **All databases** at the top of it is where you can see every
database's level at once.

Row **editing** is a second, separate opt-in on the same row, with its own
system dialog — a browsing grant never becomes a writing one on its own, and a
read-only role cannot perform it whatever the app is told. Turn it on only if
you want to try it; nothing else in the app needs it. Wherever row values are
shown they are displayed only: never uploaded, never written to disk, never
logged — and large values are cut short before they even reach the window, so the
Data tab is a preview rather than a way to read a big value in full (an editor
re-reads its row in full first, so it never saves a shortened value back).

Editing a **COMMENT** is a different thing from both, and needs neither opt-in:
the app writes the `COMMENT ON` statement and hands it to you — to the clipboard
or to a `.sql` file you name — and applies none of it. A read-only role is
therefore enough for that too. Apply the statements the way you apply any other
schema change, and re-inspect to see them land.

The map is what we are asking about — treat the Data tab as incidental unless
reaching for it tells you something about the map.

## What we'd love to hear

Open-ended — a sentence each is plenty:

1. **Did you keep it open?** Did you find yourself returning to it during real
   work, or did you open it once and forget it? Roughly how often?
2. **Did it change how you annotate?** After looking at the map, did you add or
   fix any table/column comments or `@ai`/`@policy` notes? (If so, which and
   why — even a rough count helps.)
3. **Would you miss it?** If it disappeared tomorrow, would that matter? What
   specifically would you miss, if anything?
4. **Did you notice anything new?** Was there a moment where the map showed you
   something about your own schema you hadn't registered before? What was it?

## Also useful

- Anything confusing, wrong, or missing — especially if a relationship,
  annotation, or view didn't appear where you expected. (Foreign keys to
  schemas you didn't add to the profile are intentionally hidden; views that
  read from outside those schemas show as dashed "ghost" nodes.)
- The **local MCP hub** (**Settings** → tick **Allow profiles to serve MCP on
  loopback**, then **start** on that database's row, then **AI client config**)
  serves the
  same describe surface to your own AI client, one server per profile — see the
  README for the steps. If you connect it: did starting, stopping and
  configuring them from one place beat running a server per database yourself
  (your client still lists them one by one), and did anything about pasting the
  config or keeping the app open get in the way?
- The **AI view** tab shows the payload an AI agent receives from the MCP
  describe tools of a *default-configured* kozou server (server-side opt-ins
  like RPC exposure config or privilege-aware annotations are not reproduced
  yet). Was seeing that useful?
- Crashes, slowness on large schemas, or anything that made you stop.

Send notes back however is easiest — a bulleted email is perfect. Honest "I
didn't use it much" is exactly as valuable as "I loved it"; we're testing a
hypothesis, not looking for approval.
