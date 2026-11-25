"use client";

import { useTranslations } from "next-intl";
import { Button, EmptyState } from "@saath/ui";

export default function LocaleError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("common");

  return (
    <EmptyState
      title={t("errorTitle")}
      description={t("errorBody")}
      primaryAction={
        <Button variant="primary" onClick={reset}>
          {t("retry")}
        </Button>
      }
    />
  );
}
