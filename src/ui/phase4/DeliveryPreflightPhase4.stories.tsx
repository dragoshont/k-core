import type { Meta, StoryObj } from "@storybook/react-vite";
import { ApplicationShell } from "../ApplicationShell";
import { formatEvidenceTime } from "../format";

interface Phase4DeliveryPreflightProps {
  configured: boolean;
  expiresAt: string;
  profileName: string;
  title: string;
}

function Phase4DeliveryPreflight({ configured, expiresAt, profileName, title }: Phase4DeliveryPreflightProps) {
  return (
    <article aria-labelledby="phase4-preflight-title">
      <header className="page-heading">
        <p className="eyebrow">Phase 4 target reference</p>
        <h1 id="phase4-preflight-title">{title}</h1>
        <p>This preview documents the future storage destination flow. It is not active in Phase 3.</p>
      </header>
      {!configured && <section className="notice notice--warning"><h2>OneDrive setup required</h2><p>Connect Microsoft before saving to the future storage destination.</p></section>}
      <section className="review-section"><h2>Destination</h2><p>{profileName}&apos;s OneDrive · /Apps/k</p></section>
      <section className="review-section"><h2>Preparation plan</h2><ol className="plan-list"><li>Acquire and validate the EPUB</li><li>Save one deterministic name under /Apps/k</li><li>Record provider storage evidence</li></ol></section>
      <button disabled={!configured} type="button">Acquire and save to {profileName}&apos;s OneDrive</button>
      <p className="evidence">Target preview expires <time dateTime={expiresAt}>{formatEvidenceTime(expiresAt)}</time></p>
    </article>
  );
}

const meta = {
  title: "Delivery",
  component: Phase4DeliveryPreflight,
  decorators: [(Story) => <ApplicationShell activeRoute="search"><Story /></ApplicationShell>],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Phase4DeliveryPreflight>;

export default meta;
type Story = StoryObj<typeof meta>;

const base = { expiresAt: "2026-07-17T14:36:00Z", profileName: "Member 2", title: "The Time Machine" };
export const OneDriveReady: Story = { args: { ...base, configured: true } };
export const OneDriveConfigurationRequired: Story = { args: { ...base, configured: false } };
