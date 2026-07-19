import type { Meta, StoryObj } from "@storybook/react-vite";
import { ApplicationShell } from "./ApplicationShell";
import { ActivityList, OperationTimeline, type OperationStage, type OperationStatus } from "./OperationTimeline";

const time = "2026-07-17T14:38:00Z";
const stageNames = ["preflight", "acquire", "validate", "metadata", "convert", "validate-output", "deliver", "cleanup"];
const makeStages = (current: number, failed = false): OperationStage[] => stageNames.map((name, index) => ({
  name, source: index === 6 ? "Household mail relay" : "k worker", updatedAt: time,
  status: index < current ? "succeeded" : index === current ? failed ? "failed" : "running" : "not-started",
  message: index === current && !failed ? "Working" : undefined,
  error: index === current && failed ? { reason: "EPUB validation failed.", remediation: "Choose another edition or inspect the source file.", requestId: "req-7ef2" } : undefined,
}));
const blockedDeliveryStages = (message: string, source: string): OperationStage[] => stageNames.map((name, index) => ({
  name,
  source: index === 6 ? source : "k worker",
  updatedAt: time,
  status: index < 6 ? "succeeded" : index === 6 ? "blocked" : "not-started",
  message: index === 6 ? message : undefined,
}));
const base = { correlationId: "corr-728d9c20", operationId: "728d9c20-65d0-44be-b983-16fac8a38db8", target: { title: "The Time Machine", authors: ["H. G. Wells"], provider: "Standard Ebooks", maskedDestination: "m••••••@kindle.com" }, updatedAt: time };
const meta = { title: "Operations", component: OperationTimeline, decorators: [(Story) => <ApplicationShell activeRoute="activity"><Story /></ApplicationShell>], parameters: { layout: "fullscreen" } } satisfies Meta<typeof OperationTimeline>;
export default meta;
type Story = StoryObj<typeof meta>;
const operation = (status: OperationStatus, current: number, evidence: "not-submitted" | "mail-server-accepted" | "user-confirmed-received" | "unknown" = "not-submitted") => ({ ...base, status, stages: makeStages(current, status === "failed"), deliveryEvidence: { state: evidence, source: evidence === "user-confirmed-received" ? "Member 2" : "Household mail relay", recordedAt: time, confirmedBy: evidence === "user-confirmed-received" ? "Member 2" : null } });
export const ActivityEmpty: Story = { args: operation("running", 4), render: () => <ActivityList operations={[]} /> };
export const ActivityListStory: Story = { name: "ActivityList", args: operation("running", 4), render: () => <ActivityList operations={[{ operationId: base.operationId, title: base.target.title, status: "running", deliveryEvidence: "not-submitted", updatedAt: time }, { operationId: "839e7ab1-6e17-4db5-87e0-675343fd76ce", title: "Pride and Prejudice", status: "succeeded", deliveryEvidence: "mail-server-accepted", updatedAt: "2026-07-16T19:22:00Z" }]} /> };
export const Queued: Story = { args: operation("queued", -1) };
export const Waiting: Story = { args: { ...operation("waiting", 1), stages: makeStages(0).map((stage, i) => i === 1 ? { ...stage, status: "waiting", message: "Provider asked us to wait" } : stage) } };
export const Running: Story = { args: { ...operation("running", 4), cancelable: true } };
export const Blocked: Story = { args: { ...operation("blocked", 6, "unknown"), stages: blockedDeliveryStages("Email acceptance is unknown; automatic resend is disabled.", "Household mail relay") } };
export const Canceling: Story = { args: operation("canceling", 1) };
export const Canceled: Story = { args: operation("canceled", 1) };
export const Submitted: Story = { args: { ...operation("succeeded", 8, "mail-server-accepted"), stages: makeStages(8) } };
export const Received: Story = { args: { ...operation("succeeded", 8, "user-confirmed-received"), stages: makeStages(8) } };
export const Failed: Story = { args: operation("failed", 5) };
export const Partial: Story = { args: operation("partial", 7, "unknown") };
export const Expired: Story = { args: operation("expired", 0) };
export const Unknown: Story = { args: operation("unknown", 6, "unknown") };