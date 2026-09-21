import { createFileRoute } from "@tanstack/react-router";
import { FloatSheetsPage, findPage } from "@/floatsheets/FloatSheetsPage";

const page = findPage("/");

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: page.title },
      { name: "description", content: page.description },
      { property: "og:title", content: page.title },
      { property: "og:description", content: page.description },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  return <FloatSheetsPage page={page} />;
}
