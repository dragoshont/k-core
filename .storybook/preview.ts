import type { Preview } from "@storybook/react-vite";
import "../src/ui/tokens.css";
import "../src/ui/styles.css";

const preview: Preview = {
  decorators: [
    (Story, context) => {
      if (typeof document !== "undefined") document.title = `${context.name} · k`;
      return Story();
    },
  ],
  parameters: {
    layout: "fullscreen",
    a11y: {
      test: "error",
    },
    options: {
      storySort: {
        order: ["Pages", "Shell", "Authentication", "Catalog", "Delivery", "Operations", "Profile"],
      },
    },
    viewport: {
      options: {
        iphoneSmall: { name: "iPhone small", styles: { width: "320px", height: "568px" } },
        iphone: { name: "iPhone", styles: { width: "390px", height: "844px" } },
        iphoneLarge: { name: "iPhone large", styles: { width: "430px", height: "932px" } },
        ereader: { name: "E-reader", styles: { width: "600px", height: "800px" } },
        desktop: { name: "Desktop", styles: { width: "1024px", height: "768px" } }
      },
    },
  },
  tags: ["autodocs", "test"],
};

export default preview;