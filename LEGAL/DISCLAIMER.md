# Important — please read before relying on Sidekick

**Sidekick is not a professional. It is a research tool.**

Sidekick helps you gather, organise and cross-reference information using AI models
running on your own machine. It is designed to show you the material and its sources
and let you draw your own conclusions.

That design choice is deliberate, and it cuts both ways: Sidekick will not withhold a
finding from you because it is unwelcome, **and it will not vouch for one because it
is convenient.** The responsibility for what you do with the output is yours.

## Not professional advice

Nothing Sidekick produces is medical, legal, financial, tax, psychological, or any
other kind of professional advice. In particular:

- **Medical.** Sidekick may help you understand your records, prepare questions, or
  find published material on a condition. It cannot examine you, does not know your
  full history, and is not a diagnosis or a second opinion. **Never delay, disregard,
  or stop professional medical treatment because of something Sidekick told you. In
  an emergency, contact emergency services.**
- **Legal.** Sidekick is not a lawyer and using it creates no attorney–client
  relationship or privilege. Law is jurisdiction-specific and changes; material in
  your vault may be outdated or inapplicable where you live.
- **Financial.** Sidekick does not provide personalised investment advice and is not
  a licensed advisor.

## How Sidekick can be wrong

Understanding the failure modes is more useful than a blanket warning:

1. **Language models generate plausible text, not verified fact.** A confident,
   well-formatted, fluent answer can still be wrong. Fluency is not evidence.
2. **Sidekick can only ground answers in what is in your vault.** If you researched a
   topic from weak, biased, or outdated sources, answers built on that material
   inherit those flaws. Retrieval does not fact-check the corpus.
3. **A citation proves provenance, not correctness.** It tells you a claim came from
   a specific place in a specific document — that document may still be wrong, and
   the model may still have summarised it imperfectly. **Follow citations back to the
   source for anything that matters.**
4. **The model is your choice, and models differ.** Sidekick lets you run any local
   model, including small ones that make more mistakes and uncensored ones that apply
   no editorial filter. Quality is partly a consequence of what you selected.
5. **Vault content has a date.** Research captured months ago does not know what
   happened since.

## Your data

Sidekick stores everything locally on your machine and does not transmit your
conversations, documents, or vaults to us or to any third party. Two features reach
the network **only when you use them**: your local Ollama instance, and optional web
search / Deep Research. See [PRIVACY.md](PRIVACY.md).

**Local does not mean automatically safe.** Anyone with access to your computer or
your backups may be able to read your corpus unless you enable encryption at rest
(Settings → Security). If you intend to store medical records or other sensitive
material, turn it on.

## Content you supply

You are responsible for having the right to use documents you upload and web content
you index. Sidekick stores copies of the text you give it in your local vault.

---

*This document explains the tool's limits in plain language. It is not a substitute
for the [End User Licence Agreement](EULA.md), which governs your legal rights.*
