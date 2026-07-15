# Trying kozou Desktop — what feedback helps

Thanks for trialing the semantic map. It is an early, experimental build
(`v0.1.0-alpha.1`), and we are trying to learn one thing: **does seeing your
database's compiled semantics — comments, `@ai`/`@policy` notes, views, and
relationships — as a visual map actually help you in real work?**

Please run it against **your real databases** (two or more, ideally across
different projects) for a couple of weeks, the way you normally work. There is
nothing to configure beyond adding your connection profiles.

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
- The **AI view** tab shows the payload an AI agent receives from the MCP
  describe tools of a *default-configured* kozou server (server-side opt-ins
  like RPC exposure config or privilege-aware annotations are not reproduced
  yet). Was seeing that useful?
- Crashes, slowness on large schemas, or anything that made you stop.

Send notes back however is easiest — a bulleted email is perfect. Honest "I
didn't use it much" is exactly as valuable as "I loved it"; we're testing a
hypothesis, not looking for approval.
