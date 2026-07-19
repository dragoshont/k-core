import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { ApplicationShell } from "./ApplicationShell";
import { PinSetupForm, PinUnlockForm, ProfilePicker, type HouseholdProfile } from "./Authentication";
import { BookDetail, BookSearch, type BookResult, type ProviderEvidence } from "./BookSearch";
import { DeliveryPreflight } from "./DeliveryPreflight";
import { ActivityList, OperationTimeline, type OperationStage } from "./OperationTimeline";
import { ProfileSettings } from "./ProfileSettings";

const phase3Routes = [
  { id: "search", href: "/search", label: "Search" },
  { id: "activity", href: "/activity", label: "Activity" },
  { id: "profile", href: "/profile", label: "Profile" },
] as const;

const time = "2026-07-17T14:38:00Z";
const profiles: HouseholdProfile[] = [
  { id: "00000000-0000-4000-8000-000000000001", displayName: "Member 1", credentialState: "ready" },
  { id: "00000000-0000-4000-8000-000000000002", displayName: "Member 2", credentialState: "ready" },
  { id: "00000000-0000-4000-8000-000000000003", displayName: "Member 3", credentialState: "setup-required" },
];
const books: BookResult[] = [
  { id: "plugin:project-gutenberg:1342", title: "Pride and Prejudice", authors: ["Jane Austen"], publishedYear: 1813, edition: "Project Gutenberg EPUB", languages: ["English"], capability: "candidate", capabilityReason: "Project Gutenberg reports public-domain EPUB editions; preflight rechecks the item.", source: "Project Gutenberg", checkedAt: time },
  { id: "plugin:standard-ebooks:the-time-machine", title: "The Time Machine", authors: ["H. G. Wells"], publishedYear: 1895, edition: "Standard Ebooks", languages: ["English"], capability: "candidate", capabilityReason: "Standard Ebooks reports a public-domain EPUB; preflight rechecks the item.", source: "Standard Ebooks", checkedAt: time, acquisitionOptions: [{ id: "epub", format: "epub", rightsBasis: "public-domain", estimatedBytes: 840000 }] },
  { id: "plugin:internet-archive:frankenstein-or-the-modern-prometheus", title: "Frankenstein; or, The Modern Prometheus", authors: ["Mary Wollstonecraft Shelley"], publishedYear: 1818, edition: "Internet Archive EPUB", languages: ["English"], capability: "candidate", capabilityReason: "Internet Archive reports explicit public-domain rights; preflight rechecks the record.", source: "Internet Archive", checkedAt: time },
];
const providers: ProviderEvidence[] = [
  { name: "Project Gutenberg", state: "available", checkedAt: time },
  { name: "Standard Ebooks", state: "available", checkedAt: time },
  { name: "Internet Archive", state: "unavailable", checkedAt: time, reason: "Connection timed out" },
];
const stages: OperationStage[] = ["preflight", "acquire", "validate", "metadata", "convert", "validate-output", "deliver", "cleanup"].map((name, index) => ({
  name,
  source: index === 6 ? "Household mail relay" : "k worker",
  updatedAt: time,
  status: index < 4 ? "succeeded" : index === 4 ? "running" : "not-started",
  message: index === 4 ? "Preparing EPUB" : undefined,
}));
const operationProps = {
  correlationId: "corr-728d9c20",
  deliveryEvidence: { state: "not-submitted" as const, source: "Household mail relay", recordedAt: time },
  operationId: "728d9c20-65d0-44be-b983-16fac8a38db8",
  stages,
  status: "running" as const,
  target: { title: "The Time Machine", authors: ["H. G. Wells"], provider: "Standard Ebooks", maskedDestination: "m••••••@kindle.com" },
  updatedAt: time,
};

function AuthPage({ children, description, title }: { children: React.ReactNode; description: string; title: string }) {
  return <main id="main" className="app-shell"><a className="skip-link" href="#main">Skip to content</a><div className="auth-page"><header className="auth-header"><a className="wordmark" href="/" aria-label="k home">k</a><h1>{title}</h1><p>{description}</p></header>{children}</div></main>;
}
function PageShell({ children, route = "search", eReader = false }: { children: React.ReactNode; route?: "search" | "activity" | "profile"; eReader?: boolean }) {
  return <ApplicationShell activeRoute={route} eReader={eReader} navigationRoutes={[...phase3Routes]}>{children}</ApplicationShell>;
}

const meta = { title: "Pages", parameters: { layout: "fullscreen" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Unlock: Story = { render: () => <AuthPage title="Welcome back" description="Choose your household profile."><ProfilePicker profiles={profiles} selectedId="00000000-0000-4000-8000-000000000002" /><PinUnlockForm profileId="00000000-0000-4000-8000-000000000002" profileName="Member 2" /></AuthPage> };
export const Setup: Story = { render: () => <AuthPage title="Set Member 3's PIN" description="Use the one-time code provided by the household operator."><PinSetupForm profileId="00000000-0000-4000-8000-000000000003" profileName="Member 3" /></AuthPage> };
export const Search: Story = { render: () => <PageShell><BookSearch state="partial" query="Pride and Prejudice" results={books} providers={providers} /></PageShell> };
export const BookDetailPage: Story = { name: "BookDetail", render: () => <PageShell><BookDetail book={books[1]} state="item-detail" /></PageShell> };
export const DeliveryPreflightPage: Story = { name: "DeliveryPreflight", render: () => <PageShell><DeliveryPreflight checkedAt={time} destination="m••••••@kindle.com" estimatedBytes={840000} expiresAt="2026-07-17T14:43:00Z" format="epub" maximumFileBytes={25000000} metadataSource="Standard Ebooks" outputFormat="epub" previousSubmissions={0} profileName="Member 2" provider="Standard Ebooks" rightsBasis="public-domain" state="ready" title="The Time Machine" /></PageShell> };
export const RecentAuthentication: Story = { render: () => <AuthPage title="Confirm it is you" description="This protects the delivery request."><PinUnlockForm profileId="00000000-0000-4000-8000-000000000002" profileName="Member 2" recentAuthentication /></AuthPage> };
export const ActivityEmpty: Story = { render: () => <PageShell route="activity"><ActivityList operations={[]} /></PageShell> };
export const ActivityListPage: Story = { name: "ActivityList", render: () => <PageShell route="activity"><ActivityList operations={[{ operationId: "728d9c20-65d0-44be-b983-16fac8a38db8", title: "The Time Machine", status: "running", deliveryEvidence: "not-submitted", updatedAt: time }, { operationId: "839e7ab1-6e17-4db5-87e0-675343fd76ce", title: "Pride and Prejudice", status: "succeeded", deliveryEvidence: "mail-server-accepted", updatedAt: "2026-07-16T19:22:00Z" }]} /></PageShell> };
export const OperationDetail: Story = { render: () => <PageShell route="activity"><OperationTimeline {...operationProps} /></PageShell> };
export const Profile: Story = { render: () => <PageShell route="profile"><ProfileSettings destinationStatus="ready" maskedAddress="m••••••@kindle.com" plugins={[{ displayName: "Project Gutenberg", pluginId: "project-gutenberg", support: "available" }, { displayName: "Standard Ebooks", pluginId: "standard-ebooks", support: "available" }, { displayName: "Internet Archive", pluginId: "internet-archive", support: "available" }]} profileName="Member 2" sender={{ status: "ready", source: "Household mail relay", checkedAt: time, reason: null }} /></PageShell> };
export const SearchEReader: Story = {
  render: () => <PageShell eReader><BookSearch manualRefresh state="partial" query="Pride and Prejudice" results={books} providers={providers} /></PageShell>,
  parameters: { viewport: { defaultViewport: "ereader" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("link", { name: "Refresh results" })).toBeVisible();
    const controls = canvasElement.querySelector(".search-form__controls");
    await expect(controls).not.toBeNull();
    await expect(getComputedStyle(controls!).gridTemplateColumns.trim().split(/\s+/)).toHaveLength(1);
  },
};
export const OperationDetailEReader: Story = { render: () => <PageShell eReader route="activity"><OperationTimeline {...operationProps} /></PageShell>, parameters: { viewport: { defaultViewport: "ereader" } } };