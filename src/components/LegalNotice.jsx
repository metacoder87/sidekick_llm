// The limits of the tool, stated in the app rather than only in a LEGAL/ file the
// user will never open. Text is inlined deliberately: it must render with no
// filesystem access and no network, in a packaged build, while the app is locked.
//
// Tone matters here. Sidekick is not a moral guardian — it does not withhold findings
// or soften them (ROADMAP Stance §1, invariant #9). So this says what the tool can
// get *wrong*, which is genuinely useful, rather than warning the user off topics.

export function DisclaimerSummary() {
  return (
    <div className="legal-summary">
      <strong>Sidekick is a research tool, not a professional.</strong> It shows you material and
      its sources so you can judge for yourself — it does not give medical, legal, or financial
      advice, and its answers can be confidently wrong. Verify anything that matters by following
      the citation back to the source.
    </div>
  );
}

export default function LegalNotice() {
  return (
    <div className="legal-panel">
      <h3>What Sidekick is, and is not</h3>
      <p>
        Sidekick helps you gather, organise and cross-reference information using models running on
        your own machine. It presents the material and its sources and lets you draw your own
        conclusions.
      </p>
      <p>
        That cuts both ways: it will not withhold a finding because it is unwelcome, and it will not
        vouch for one because it is convenient. What you do with the output is your decision.
      </p>

      <h3>Not professional advice</h3>
      <p>
        Nothing Sidekick produces is medical, legal, financial, tax or psychological advice, and
        using it creates no professional relationship or privilege.
      </p>
      <ul>
        <li>
          <strong>Medical.</strong> Sidekick can help you understand your records and prepare
          questions. It cannot examine you and is not a diagnosis. Never delay or stop professional
          treatment because of something Sidekick told you. In an emergency, contact emergency
          services.
        </li>
        <li>
          <strong>Legal.</strong> Law is jurisdiction-specific and changes. Material in your vault
          may be outdated or inapplicable where you live.
        </li>
        <li>
          <strong>Financial.</strong> Sidekick is not a licensed advisor and does not give
          personalised investment advice.
        </li>
      </ul>

      <h3>How Sidekick can be wrong</h3>
      <ol>
        <li>
          Language models generate plausible text, not verified fact. A fluent, well-formatted
          answer can still be wrong — fluency is not evidence.
        </li>
        <li>
          Answers can only be grounded in what is in your vault. Research built on weak or outdated
          sources produces answers with the same flaws; retrieval does not fact-check your corpus.
        </li>
        <li>
          A citation proves provenance, not correctness. It shows where a claim came from — that
          source may still be wrong, and the summary of it may be imperfect.
        </li>
        <li>
          The model is your choice, and models differ. Smaller models make more mistakes; uncensored
          models apply no editorial filter.
        </li>
        <li>Vault content has a date, and does not know what happened since.</li>
      </ol>

      <h3>Your data</h3>
      <p>
        Everything stays on this machine. There is no account, no telemetry, and no server. The
        network is used only by your local Ollama, by web search and Deep Research when you run them
        (which send your <em>queries</em> to the provider you chose, not your documents), and by
        model downloads.
      </p>
      <p>
        Local does not automatically mean safe: anyone with access to this computer or its backups
        may be able to read your corpus unless you enable encryption at rest under Security &amp;
        Audit. If you are storing medical records, turn it on.
      </p>
      <p>
        You are responsible for having the right to use documents you upload and web content you
        index.
      </p>

      <p className="legal-panel__footnote">
        Full text ships with the application in the <code>LEGAL</code> folder: disclaimer, privacy
        policy, and licence agreement.
      </p>
    </div>
  );
}
