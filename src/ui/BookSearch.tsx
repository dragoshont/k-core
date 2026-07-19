import { formatEvidenceTime } from "./format";

export type BookCapability = "candidate" | "deliverable" | "metadata-only";

export interface MetadataEvidence {
  averageRating?: number | null;
  checkedAt: string;
  contributedFields: string[];
  informationLink?: string | null;
  matchedBy: string;
  provider: string;
  ratingsCount?: number | null;
  recordId: string;
}

export interface CapabilityEvidence {
  capability: string;
  checkedAt: string;
  provider: string;
  reason: string;
  source: string;
  state: "available" | "configuration-required" | "eligibility-required" | "unsupported" | "not-exposed";
}

export interface BookResult {
  id: string;
  title: string;
  authors: string[];
  publishedYear?: number;
  edition?: string;
  languages?: string[];
  coverUrl?: string;
  capability: BookCapability;
  capabilityReason: string;
  provenance?: "unverified-provenance" | "verified-public-domain";
  source: string;
  checkedAt: string;
  capabilityEvidence?: CapabilityEvidence[];
  metadataEvidence?: MetadataEvidence[];
  acquisitionOptions?: Array<{
    id: string;
    format: "epub";
    rightsBasis: "public-domain" | "user-owned" | "licensed-private";
    estimatedBytes?: number;
  }>;
}

export interface BookDetailProps {
  book?: BookResult;
  csrfToken?: string;
  state: "item-detail" | "item-not-found";
}

export interface ProviderEvidence {
  name: string;
  state: "available" | "unavailable" | "configuration-required" | "eligibility-required" | "unsupported" | "not-exposed";
  checkedAt: string;
  reason?: string;
}

export interface BookSearchProps {
  manualRefresh?: boolean;
  query?: string;
  results?: BookResult[];
  providers?: ProviderEvidence[];
  state: "idle" | "loading" | "results" | "partial" | "no-results" | "failed";
}

const capabilityLabels: Record<BookCapability, string> = {
  candidate: "Check availability",
  deliverable: "Ready to prepare",
  "metadata-only": "Information only",
};

const providerStateLabels: Record<CapabilityEvidence["state"], string> = {
  available: "Available",
  "configuration-required": "Operator setup required",
  "eligibility-required": "Operator eligibility required",
  unsupported: "Unsupported",
  "not-exposed": "Not exposed by provider",
};

function readableTime(value: string) {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(new Date(value));
}

export function BookSearch({ manualRefresh = false, query = "", results = [], providers = [], state }: BookSearchProps) {
  const availableResults = state === "results" || state === "partial";

  return (
    <section aria-labelledby="search-title">
      <header className="page-heading">
        <p className="eyebrow">Find a book</p>
        <h1 id="search-title">Search the shelves</h1>
        <p>One search across trusted catalogs. Sending is offered only when a file can be acquired lawfully.</p>
      </header>

      <form className="search-form" role="search" method="get" action="/search">
        <label htmlFor="book-query">Title, author, or ISBN</label>
        <div className="search-form__controls">
          <input id="book-query" name="q" type="search" defaultValue={query} minLength={2} maxLength={200} />
          <button type="submit">Search</button>
        </div>
      </form>
      {manualRefresh && <p className="manual-refresh"><a href={`/search?q=${encodeURIComponent(query)}`}>Refresh results</a></p>}

      {state === "idle" && (
        <div className="empty-state">
          <h2>What would you like to read?</h2>
          <p>Try a title, an author, or an ISBN.</p>
        </div>
      )}

      {state === "loading" && <p className="status-line" role="status">Searching trusted catalogs...</p>}

      {state === "partial" && (
        <aside className="notice notice--warning" aria-labelledby="partial-title">
          <h2 id="partial-title">Some catalogs did not answer</h2>
          <p>Results from available sources are shown below. Availability may be incomplete.</p>
          <ul className="evidence-list">
            {providers.filter((provider) => provider.state === "unavailable").map((provider) => (
              <li key={provider.name}>
                <strong>{provider.name}</strong>: {provider.reason ?? "Unavailable"} · checked {readableTime(provider.checkedAt)} UTC
              </li>
            ))}
          </ul>
        </aside>
      )}

      {state === "no-results" && (
        <div className="empty-state">
          <h2>No books found for “{query}”</h2>
          <p>Check the spelling or search for the author instead.</p>
        </div>
      )}

      {state === "failed" && (
        <div className="notice notice--danger" role="alert">
          <h2>Search is unavailable</h2>
          <p>None of the configured catalogs answered. Try again in a few minutes.</p>
        </div>
      )}

      {availableResults && (
        <section className="results" aria-labelledby="results-title">
          <div className="section-heading">
            <h2 id="results-title">Results for “{query}”</h2>
            <span>{results.length} books</span>
          </div>
          <ol className="result-list">
            {results.map((book) => (
              <li key={book.id}>
                <article className="book-result">
                  <div className="book-cover" aria-hidden="true">
                    {book.coverUrl ? <img src={book.coverUrl} alt="" width="72" height="108" /> : <span>No cover</span>}
                  </div>
                  <div className="book-result__body">
                    <div>
                      <h3><a href={`/books/${encodeURIComponent(book.id)}`}>{book.title}</a></h3>
                      <p className="book-author">{book.authors.join(", ")}</p>
                    </div>
                    <p className="book-edition">
                      {[book.edition, book.publishedYear, book.languages?.join(", ")].filter(Boolean).join(" · ")}
                    </p>
                    <div className={`capability capability--${book.capability}`}>
                      <strong>{capabilityLabels[book.capability]}</strong>
                      <span>{book.capabilityReason}</span>
                    </div>
                    <p className="evidence">{book.source} · checked <time dateTime={book.checkedAt}>{readableTime(book.checkedAt)} UTC</time></p>
                  </div>
                </article>
              </li>
            ))}
          </ol>
        </section>
      )}
    </section>
  );
}

export function BookDetail({ book, csrfToken = "storybook-csrf-token-not-a-secret", state }: BookDetailProps) {
  if (state === "item-not-found" || !book) {
    return (
      <section aria-labelledby="book-not-found-title">
        <header className="page-heading">
          <p className="eyebrow">Book information</p>
          <h1 id="book-not-found-title">Book not found</h1>
          <p>This result is no longer available. Return to search for another edition.</p>
        </header>
        <a className="button-link button-link--secondary" href="/search">Return to search</a>
      </section>
    );
  }

  return (
    <article aria-labelledby="book-detail-title">
      <a className="back-link" href="/search">← Search results</a>
      <header className="book-detail-header">
        <div className="book-cover book-cover--detail" aria-hidden="true">
          {book.coverUrl ? <img src={book.coverUrl} alt="" width="120" height="180" /> : <span>No cover</span>}
        </div>
        <div className="page-heading">
          <p className="eyebrow">Book information</p>
          <h1 id="book-detail-title">{book.title}</h1>
          <p>{book.authors.join(", ")}</p>
        </div>
      </header>
      <section className="review-section" aria-labelledby="edition-detail-title">
        <h2 id="edition-detail-title">Edition</h2>
        <dl className="evidence-grid">
          <div><dt>Edition</dt><dd>{book.edition ?? "Not reported"}</dd></div>
          <div><dt>Published</dt><dd>{book.publishedYear ?? "Not reported"}</dd></div>
          <div><dt>Language</dt><dd>{book.languages?.join(", ") ?? "Not reported"}</dd></div>
          <div><dt>Source</dt><dd>{book.source}</dd></div>
        </dl>
      </section>
      <section className="review-section" aria-labelledby="availability-title">
        <h2 id="availability-title">Availability</h2>
        <div className={`capability capability--${book.capability}`}>
          <strong>{capabilityLabels[book.capability]}</strong>
          <span>{book.capabilityReason}</span>
        </div>
        {book.acquisitionOptions && book.acquisitionOptions.length > 0 && (
          <form className="option-form" method="post" action="/delivery/preflight">
            <input type="hidden" name="catalogRef" value={book.id} />
            <input type="hidden" name="csrfToken" value={csrfToken} />
            <fieldset>
              <legend>Choose an authorized file</legend>
              {book.acquisitionOptions.map((option) => (
                <label className="radio-row" key={option.id}>
                  <input name="optionId" required type="radio" value={option.id} />
                  <span><strong>{option.format.toUpperCase()}</strong> · {option.rightsBasis.replaceAll("-", " ")}</span>
                </label>
              ))}
            </fieldset>
            <button type="submit">Check availability</button>
          </form>
        )}
        <p className="evidence">Checked <time dateTime={book.checkedAt}>{formatEvidenceTime(book.checkedAt)}</time></p>
      </section>
      {book.metadataEvidence && book.metadataEvidence.length > 0 && (
        <section className="review-section" aria-labelledby="metadata-evidence-title">
          <h2 id="metadata-evidence-title">Ratings and metadata</h2>
          <ul className="evidence-list evidence-list--ruled">
            {book.metadataEvidence.map((evidence) => (
              <li key={`${evidence.provider}:${evidence.recordId}`}>
                <strong>{evidence.provider}</strong>
                {evidence.averageRating != null && <p>{evidence.averageRating.toFixed(1)} out of 5 from {new Intl.NumberFormat("en").format(evidence.ratingsCount ?? 0)} ratings</p>}
                <p>Matched by {evidence.matchedBy.replaceAll("-", " ")} · fields: {evidence.contributedFields.join(", ")}</p>
                <p className="evidence">Checked <time dateTime={evidence.checkedAt}>{formatEvidenceTime(evidence.checkedAt)}</time>{evidence.informationLink && <> · <a href={evidence.informationLink}>View provider record</a></>}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {book.capabilityEvidence && book.capabilityEvidence.length > 0 && (
        <section className="review-section" aria-labelledby="provider-capability-title">
          <h2 id="provider-capability-title">Provider coverage</h2>
          <ul className="evidence-list evidence-list--ruled">
            {book.capabilityEvidence.map((evidence) => (
              <li key={`${evidence.provider}:${evidence.capability}`}>
                <strong>{evidence.provider}: {providerStateLabels[evidence.state]}</strong>
                <p>{evidence.reason}</p>
                <p className="evidence">{evidence.source} · <time dateTime={evidence.checkedAt}>{formatEvidenceTime(evidence.checkedAt)}</time></p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}