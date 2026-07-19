import type { Meta, StoryObj } from "@storybook/react-vite";
import { ApplicationShell } from "./ApplicationShell";

const meta = { title: "Shell", component: ApplicationShell, parameters: { layout: "fullscreen" } } satisfies Meta<typeof ApplicationShell>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Authenticated: Story = { args: { activeRoute: "search", children: <div className="page-heading"><p className="eyebrow">Shell preview</p><h1>Search</h1><p>The main content begins here.</p></div> } };
export const EReader: Story = { args: { activeRoute: "search", children: <div className="page-heading"><p className="eyebrow">E-reader shell</p><h1>Search</h1><p>Navigation stays in the document flow.</p></div>, eReader: true }, parameters: { viewport: { defaultViewport: "ereader" } } };