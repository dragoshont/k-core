import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { ApplicationShell } from "./ApplicationShell";
import { BookDetail, BookSearch, type BookResult, type ProviderEvidence } from "./BookSearch";

const checkedAt = "2026-07-17T14:31:00Z";
const results: BookResult[] = [
  {
    id: "plugin:project-gutenberg:1342",
    title: "Pride and Prejudice",
    authors: ["Jane Austen"],
    publishedYear: 1813,
    edition: "Project Gutenberg EPUB",
    languages: ["English"],
    capability: "candidate",
    capabilityReason: "Project Gutenberg reports public-domain EPUB editions; preflight rechecks the item.",
    source: "Project Gutenberg",
    checkedAt,
  },
  {
    id: "standard-ebooks:the-time-machine",
    title: "The Time Machine",
    authors: ["H. G. Wells"],
    publishedYear: 1895,
    edition: "Standard Ebooks",
    languages: ["English"],
    capability: "candidate",
    capabilityReason: "Standard Ebooks reports a public-domain EPUB; preflight rechecks the item.",
    source: "Standard Ebooks",
    checkedAt,
  },
  {
    id: "plugin:internet-archive:frankenstein-or-the-modern-prometheus",
    title: "Frankenstein; or, The Modern Prometheus: a deliberately long edition title that must wrap without hiding evidence",
    authors: ["Mary Wollstonecraft Shelley"],
    edition: "Internet Archive EPUB",
    languages: ["English"],
    capability: "candidate",
    capabilityReason: "Internet Archive reports explicit public-domain rights; preflight rechecks the record.",
    source: "Internet Archive",
    checkedAt,
  },
];

const providers: ProviderEvidence[] = [
  { name: "Project Gutenberg", state: "available", checkedAt },
  { name: "Standard Ebooks", state: "available", checkedAt },
  { name: "Internet Archive", state: "unavailable", checkedAt, reason: "Connection timed out" },
];

const meta = {
  title: "Catalog",
  component: BookSearch,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <ApplicationShell activeRoute="search">
        <Story />
      </ApplicationShell>
    ),
  ],
} satisfies Meta<typeof BookSearch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = { args: { state: "idle" } };
export const Loading: Story = { args: { state: "loading", query: "Pride and Prejudice" } };
export const Results: Story = {
  args: { state: "results", query: "Pride and Prejudice", results, providers },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "Results for “Pride and Prejudice”" })).toBeInTheDocument();
    await expect(canvas.getAllByText("Check availability")).toHaveLength(3);
  },
};
export const Partial: Story = { args: { state: "partial", query: "Pride and Prejudice", results, providers } };
export const NoResults: Story = { args: { state: "no-results", query: "Unknown book" } };
export const Failure: Story = { args: { state: "failed", query: "Pride and Prejudice" } };
export const ItemDetail: Story = { args: { state: "idle" }, render: () => <BookDetail book={{ ...results[1], acquisitionOptions: [{ id: "epub", format: "epub", rightsBasis: "public-domain", estimatedBytes: 840000 }] }} state="item-detail" /> };
export const ItemDetailWithMetadata: Story = {
  args: { state: "idle" },
  render: () => <BookDetail
    book={{
      ...results[1],
      acquisitionOptions: [{ id: "epub", format: "epub", rightsBasis: "public-domain", estimatedBytes: 840000 }],
      metadataEvidence: [{ averageRating: 4.1, checkedAt, contributedFields: ["average rating", "ratings count", "information link"], informationLink: "https://books.google.com/books?id=fixture-volume", matchedBy: "isbn-13", provider: "Google Books", ratingsCount: 1842, recordId: "fixture-volume" }],
      capabilityEvidence: [
        { capability: "reviews", checkedAt, provider: "Goodreads", reason: "Goodreads does not offer a supported new API integration. k does not scrape it.", source: "Provider policy", state: "unsupported" },
        { capability: "product-availability", checkedAt, provider: "Amazon", reason: "An eligible operator registration for the current Creators API is required.", source: "Deployment capability inventory", state: "eligibility-required" },
        { capability: "kindle-unlimited", checkedAt, provider: "Amazon", reason: "No supported API exposes a trustworthy Kindle Unlimited entitlement signal.", source: "Provider policy", state: "not-exposed" },
      ],
    }}
    state="item-detail"
  />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("4.1 out of 5 from 1,842 ratings")).toBeInTheDocument();
    await expect(canvas.getByText(/k does not scrape it/i)).toBeInTheDocument();
    await expect(canvas.getByText(/No supported API exposes a trustworthy Kindle Unlimited entitlement signal/i)).toBeInTheDocument();
  },
};
export const ItemNotFound: Story = { args: { state: "idle" }, render: () => <BookDetail state="item-not-found" /> };