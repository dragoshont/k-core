import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { PinSetupForm, PinUnlockForm, ProfilePicker as ProfilePickerComponent, type HouseholdProfile } from "./Authentication";

const profiles: HouseholdProfile[] = [
  { id: "00000000-0000-4000-8000-000000000001", displayName: "Member 1", credentialState: "ready" },
  { id: "00000000-0000-4000-8000-000000000002", displayName: "Member 2", credentialState: "ready" },
  { id: "00000000-0000-4000-8000-000000000003", displayName: "Member 3", credentialState: "setup-required" },
];

function AuthFrame({ children, title, description }: { children: React.ReactNode; title: string; description: string }) {
  return <main className="app-shell"><div className="auth-page"><header className="auth-header"><a className="wordmark" href="/" aria-label="k home">k</a><h1>{title}</h1><p>{description}</p></header>{children}</div></main>;
}

const meta = { title: "Authentication", parameters: { layout: "fullscreen" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const ProfilePicker: Story = { render: () => <AuthFrame title="Welcome back" description="Choose your household profile."><ProfilePickerComponent profiles={profiles} /></AuthFrame> };
export const ProfileSelected: Story = { render: () => <AuthFrame title="Welcome back" description="Choose your household profile."><ProfilePickerComponent profiles={profiles} selectedId="00000000-0000-4000-8000-000000000002" /></AuthFrame> };
export const SetupRequired: Story = { render: () => <AuthFrame title="Welcome back" description="Choose your household profile."><ProfilePickerComponent profiles={profiles} selectedId="00000000-0000-4000-8000-000000000003" /></AuthFrame> };
export const RecoveryRequired: Story = { render: () => <AuthFrame title="Recovery required" description="Use a fresh code from the household operator."><ProfilePickerComponent profiles={[...profiles.slice(0, 2), { ...profiles[2], credentialState: "recovery-required" }]} selectedId="00000000-0000-4000-8000-000000000003" /></AuthFrame> };
export const PinReady: Story = {
  render: () => <AuthFrame title="Hi, Member 2" description="Enter your four-digit PIN."><PinUnlockForm profileId="00000000-0000-4000-8000-000000000002" profileName="Member 2" /></AuthFrame>,
  play: async ({ canvasElement }) => { const canvas = within(canvasElement); const pin = canvas.getByLabelText("Member 2's PIN"); await userEvent.type(pin, "0123"); await expect(pin).toHaveValue("0123"); },
};
export const PinSubmitting: Story = { render: () => <AuthFrame title="Hi, Member 2" description="Enter your four-digit PIN."><PinUnlockForm profileId="00000000-0000-4000-8000-000000000002" profileName="Member 2" state="submitting" /></AuthFrame> };
export const PinError: Story = { render: () => <AuthFrame title="Error: unlock Member 2" description="Enter your four-digit PIN."><PinUnlockForm error="The profile or PIN was not accepted." profileId="00000000-0000-4000-8000-000000000002" profileName="Member 2" state="invalid" /></AuthFrame> };
export const PinDelayed: Story = { render: () => <AuthFrame title="Try again shortly" description="PIN attempts are temporarily delayed."><PinUnlockForm delayedUntil="2026-07-17T14:36:00Z" profileId="00000000-0000-4000-8000-000000000002" profileName="Member 2" state="delayed" /></AuthFrame> };
export const RecentAuthentication: Story = { render: () => <AuthFrame title="Confirm it is you" description="This protects changes to delivery settings."><PinUnlockForm profileId="00000000-0000-4000-8000-000000000002" profileName="Member 2" recentAuthentication /></AuthFrame> };
export const SetupReady: Story = { render: () => <AuthFrame title="Set Member 3's PIN" description="Use the one-time code provided by the household operator."><PinSetupForm profileId="00000000-0000-4000-8000-000000000003" profileName="Member 3" /></AuthFrame> };
export const SetupSubmitting: Story = { render: () => <AuthFrame title="Set Member 3's PIN" description="Use the one-time code provided by the household operator."><PinSetupForm profileId="00000000-0000-4000-8000-000000000003" profileName="Member 3" state="submitting" /></AuthFrame> };
export const SetupError: Story = { render: () => <AuthFrame title="Error: set Member 3's PIN" description="Use a fresh one-time code."><PinSetupForm error="The code or profile was not accepted." profileId="00000000-0000-4000-8000-000000000003" profileName="Member 3" state="invalid" /></AuthFrame> };
export const SetupConflict: Story = { render: () => <AuthFrame title="Setup changed" description="The profile changed before this code was used."><PinSetupForm error="Ask the household operator for a fresh code." profileId="00000000-0000-4000-8000-000000000003" profileName="Member 3" state="conflict" /></AuthFrame> };
export const SetupPinRejected: Story = { render: () => <AuthFrame title="Choose another PIN" description="The new PIN cannot be used."><PinSetupForm error="Choose a PIN that is not common or used by another profile." profileId="00000000-0000-4000-8000-000000000003" profileName="Member 3" state="pin-rejected" /></AuthFrame> };
export const SetupThrottled: Story = { render: () => <AuthFrame title="Try again shortly" description="Code attempts are temporarily delayed."><PinSetupForm error="Wait before trying another code." profileId="00000000-0000-4000-8000-000000000003" profileName="Member 3" state="throttled" /></AuthFrame> };
export const SetupCompleted: Story = { render: () => <AuthFrame title="Setup complete" description="Member 3 can now unlock k."><PinSetupForm profileId="00000000-0000-4000-8000-000000000003" profileName="Member 3" state="completed" /></AuthFrame> };