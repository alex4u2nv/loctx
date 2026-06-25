# loctx starter ast-grep rules

A small, opinionated set of high-signal structural lints loctx runs by
default when you haven't pointed ast-grep at your own rule directories
(`analyzers.astGrep.bundledRules`, on by default). They double as
**examples** — copy one, edit the `rule.pattern`, and point ast-grep at
your own dir to replace these entirely.

Format: one ast-grep rule per `.yml`. See
https://ast-grep.github.io/guide/rule-config.html
