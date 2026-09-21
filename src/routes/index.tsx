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
      { property: "og:image", content: "https://project--683db3df-de4d-4438-9d0d-5c7b09d291cc.lovable.app/og-image.jpg" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image", content: "https://project--683db3df-de4d-4438-9d0d-5c7b09d291cc.lovable.app/og-image.jpg" },
    ],
  }),
  component: Index,
});

function Index() {
  return <FloatSheetsPage page={page} />;
}
