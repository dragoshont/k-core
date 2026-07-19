import type { Meta, StoryObj } from "@storybook/react-vite";
import { ApplicationShell } from "../ApplicationShell";
import { formatEvidenceTime } from "../format";

interface Phase4OperationProps {
  evidence: string;
  message: string;
  provider: string;
  status: "blocked" | "queued" | "succeeded";
  title: string;
}

function Phase4OperationTimeline({ evidence, message, provider, status, title }: Phase4OperationProps) {
  const tone = status === "succeeded" ? "success" : status === "blocked" ? "warning" : "neutral";
  const time = "2026-07-17T14:38:00Z";
  return (
    <article aria-labelledby="phase4-operation-title">
      <header className="page-heading">
        <p className="eyebrow">Phase 4 target reference</p>
        <h1 id="phase4-operation-title">{title}</h1>
        <p>{provider} · future external-effect evidence</p>
      </header>
      <p><span className={`status-badge status-badge--${tone}`}>{status}</span></p>
      <section className="review-section" aria-labelledby="phase4-evidence-title">
        <h2 id="phase4-evidence-title">Provider evidence</h2>
        <p><strong>{evidence}</strong></p>
        <p>{message}</p>
        <p className="evidence">{provider} · <time dateTime={time}>{formatEvidenceTime(time)}</time></p>
      </section>
      <p className="notice notice--warning">Target-only Storybook reference. No Phase 3 route can create this operation.</p>
    </article>
  );
}

const meta = {
  title: "Operations",
  component: Phase4OperationTimeline,
  decorators: [(Story) => <ApplicationShell activeRoute="activity"><Story /></ApplicationShell>],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Phase4OperationTimeline>;

export default meta;
type Story = StoryObj<typeof meta>;

export const GmailSubmitted: Story = { args: { evidence: "Submitted by Gmail", message: "Provider acceptance does not prove Kindle receipt.", provider: "Gmail API", status: "succeeded", title: "The Time Machine" } };
export const GmailUnknown: Story = { args: { evidence: "Delivery unknown", message: "Automatic resend remains blocked after an ambiguous provider effect.", provider: "Gmail API", status: "blocked", title: "The Time Machine" } };
export const OneDriveQueued: Story = { args: { evidence: "Not uploaded", message: "The future storage operation is waiting to start.", provider: "Microsoft Graph", status: "queued", title: "The Time Machine" } };
export const OneDriveSaved: Story = { args: { evidence: "Saved to OneDrive", message: "The provider returned a drive item; device sync is not claimed.", provider: "Microsoft Graph", status: "succeeded", title: "The Time Machine.epub" } };
export const OneDriveUnknown: Story = { args: { evidence: "Storage unknown", message: "The deterministic path could not be reconciled; no second name is created.", provider: "Microsoft Graph", status: "blocked", title: "The Time Machine.epub" } };
