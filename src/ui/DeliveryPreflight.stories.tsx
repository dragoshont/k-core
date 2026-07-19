import type { Meta, StoryObj } from "@storybook/react-vite";
import { ApplicationShell } from "./ApplicationShell";
import { DeliveryPreflight } from "./DeliveryPreflight";

const base = {
  checkedAt: "2026-07-17T14:31:00Z", destination: "m••••••@kindle.com", estimatedBytes: 1_840_000,
  expiresAt: "2026-07-17T14:36:00Z", format: "epub" as const, maximumFileBytes: 25_000_000,
  metadataSource: "Standard Ebooks", outputFormat: "epub" as const, previousSubmissions: 0,
  profileName: "Member 2", provider: "Standard Ebooks", rightsBasis: "public-domain" as const,
  title: "The Time Machine",
};
const meta = { title: "Delivery", component: DeliveryPreflight, decorators: [(Story) => <ApplicationShell activeRoute="search"><Story /></ApplicationShell>], parameters: { layout: "fullscreen" } } satisfies Meta<typeof DeliveryPreflight>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Checking: Story = { args: { ...base, state: "checking" } };
export const Ready: Story = { args: { ...base, state: "ready" } };
export const Warning: Story = { args: { ...base, estimatedBytes: null, state: "warning", warnings: [{ code: "SOURCE_SIZE_UNKNOWN", reason: "The source did not report an estimated file size.", remediation: "k will enforce the 25 MB limit while acquiring the EPUB." }] } };
export const Blocked: Story = { args: { ...base, state: "blocked", blockers: [{ code: "FILE_TOO_LARGE", reason: "The reported file exceeds the household limit.", remediation: "Choose another edition." }] } };
export const Expired: Story = { args: { ...base, state: "expired" } };
export const ConfigurationRequired: Story = { args: { ...base, destination: null, state: "configuration-required" } };
export const DestinationRevisionChanged: Story = { args: { ...base, state: "stale-at-submit", warnings: [{ code: "DESTINATION_REVISION_CHANGED", reason: "The Kindle destination changed after this check.", remediation: "Return to the book and check again." }] } };
export const RecentAuthenticationRequired: Story = { args: { ...base, recentAuthenticationRequired: true, state: "recent-authentication-required" } };
export const StaleAtSubmit: Story = { args: { ...base, state: "stale-at-submit" } };