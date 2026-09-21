import { createFileRoute } from "@tanstack/react-router";
import { FloatSheetsPage, findPage } from "@/floatsheets/FloatSheetsPage";

export const Route = createFileRoute("/$")({
  head: ({ params }) => {
    const page = findPage("/" + (params._splat ?? ""));
    return {
      meta: [
        { title: page.title },
        { name: "description", content: page.description },
        { property: "og:title", content: page.title },
        { property: "og:description", content: page.description },
        { property: "og:type", content: "website" },
        { name: "twitter:card", content: "summary_large_image" },
      ],
    };
  },
  component: CatchAll,
});

function CatchAll() {
  const { _splat } = Route.useParams();
  const page = findPage("/" + (_splat ?? ""));
  return <FloatSheetsPage page={page} />;
}
