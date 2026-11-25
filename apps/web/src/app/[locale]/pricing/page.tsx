"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BottomSheet, Button, useToast } from "@saath/ui";
import { parseProblemDetail, type CheckoutResponse } from "@saath/contracts";
import { useAuth } from "@/components/AuthProvider";

export default function PricingPage() {
  const t = useTranslations("pricing");
  const tCommon = useTranslations("common");
  const { authKind, apiClient, openOtpModal } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [selectedPlanCode, setSelectedPlanCode] = useState<string>("group_organiser_pass");
  const [selectedJourneyId, setSelectedJourneyId] = useState<string>("");
  const [activeOrder, setActiveOrder] = useState<CheckoutResponse | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  const plansQuery = useQuery({
    queryKey: ["pricing-plans"],
    queryFn: async () => {
      const { data, error } = await apiClient.GET("/v1/pricing/plans");
      if (error || !data) {
        throw new Error(parseProblemDetail(error)?.detail || tCommon("errorBody"));
      }
      return data;
    },
  });

  const entitlementsQuery = useQuery({
    queryKey: ["entitlements"],
    enabled: authKind === "user",
    queryFn: async () => {
      const { data, error } = await apiClient.GET("/v1/me/entitlements");
      if (error || !data) {
        throw new Error(parseProblemDetail(error)?.detail || tCommon("errorBody"));
      }
      return data;
    },
  });

  const journeysQuery = useQuery({
    queryKey: ["journeys"],
    enabled: authKind === "user",
    queryFn: async () => {
      const { data, error } = await apiClient.GET("/v1/journeys");
      if (error || !data) {
        return { items: [] };
      }
      return data;
    },
  });

  const checkoutMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await apiClient.POST("/v1/billing/checkout", {
        body: {
          plan_code: selectedPlanCode,
          journey_instance_id:
            selectedPlanCode === "group_organiser_pass" ? selectedJourneyId || null : null,
        },
      });
      if (error || !data) {
        throw new Error(parseProblemDetail(error)?.detail || tCommon("errorBody"));
      }
      return data;
    },
    onSuccess: (order) => {
      setCheckoutError(null);
      setActiveOrder(order);
    },
    onError: (err) => {
      setCheckoutError(err.message);
    },
  });

  const sandboxMutation = useMutation({
    mutationFn: async (orderId: string) => {
      const { data, error } = await apiClient.POST("/v1/billing/sandbox/complete", {
        body: { order_id: orderId, outcome: "paid" },
      });
      if (error || !data) {
        throw new Error(parseProblemDetail(error)?.detail || tCommon("errorBody"));
      }
      return data;
    },
    onSuccess: async () => {
      setActiveOrder(null);
      setCheckoutOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["entitlements"] });
      await queryClient.invalidateQueries({ queryKey: ["journeys"] });
      showToast({ variant: "success", message: t("activatedToast") });
    },
    onError: (err) => {
      setCheckoutError(err.message);
    },
  });

  const openCheckout = (planCode: string) => {
    if (authKind !== "user") {
      openOtpModal();
      return;
    }
    setSelectedPlanCode(planCode);
    setActiveOrder(null);
    setCheckoutError(null);
    const firstJourney = journeysQuery.data?.items[0]?.journey.id ?? "";
    setSelectedJourneyId(firstJourney);
    setCheckoutOpen(true);
  };

  const activeEntitlements =
    entitlementsQuery.data?.entitlements.filter((e) => e.status === "active") ?? [];

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h1
          className="text-2xl font-extrabold text-[var(--text)] sm:text-3xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("title")}
        </h1>
        <p className="text-sm text-[var(--text-muted)]">{t("subtitle")}</p>
      </section>

      <div className="rounded-[var(--radius-sm)] border border-[var(--secondary)] bg-[var(--surface-2)] px-4 py-3 text-sm font-medium text-[var(--text)]">
        {t("guaranteeBanner")}
      </div>

      {authKind === "user" ? (
        <section className="space-y-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)]">
          <h2 className="text-sm font-bold text-[var(--text)]">{t("activePassTitle")}</h2>
          {activeEntitlements.length === 0 ? (
            <p className="text-xs text-[var(--text-muted)]">{t("noEntitlements")}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {activeEntitlements.map((ent) => (
                <span
                  key={ent.id}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[var(--success)] bg-[var(--surface-2)] px-3 py-1 text-xs font-semibold text-[var(--success)]"
                >
                  ✓ {ent.plan_code} · {t("activeStatus")}
                </span>
              ))}
            </div>
          )}
        </section>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {(plansQuery.data?.plans ?? []).map((plan) => {
          const isFree = plan.code === "free_passenger";
          const isOrganiser = plan.code === "group_organiser_pass";
          const badge = isFree
            ? t("freeBadge")
            : isOrganiser
              ? t("perTripBadge")
              : t("b2bBadge");
          return (
            <article
              key={plan.code}
              className={`flex flex-col justify-between space-y-4 rounded-[var(--radius)] border bg-[var(--surface)] p-5 shadow-[var(--shadow)] ${
                isOrganiser ? "border-[var(--primary-btn-bg)]" : "border-[var(--border)]"
              }`}
            >
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h2
                    className="text-lg font-bold text-[var(--text)]"
                    style={{ fontFamily: "var(--font-display)" }}
                  >
                    {plan.name}
                  </h2>
                  <span className="rounded-full bg-[var(--surface-2)] px-2.5 py-1 text-xs font-bold text-[var(--primary-text)]">
                    {badge}
                  </span>
                </div>

                <ul className="space-y-1.5 text-xs text-[var(--text-muted)]">
                  <li>✓ {t("featureFreeSwaps")}</li>
                  <li>✓ {t("upToMembers", { count: plan.max_party_members })}</li>
                  {plan.organiser_dashboard ? <li>✓ {t("featureOrganiserDashboard")}</li> : null}
                  {plan.summary_export ? <li>✓ {t("featureSummaryExport")}</li> : null}
                  {plan.b2b_api ? <li>✓ {t("featureB2bApi")}</li> : null}
                  <li>✓ {t("featureNoSeatBump")}</li>
                </ul>
              </div>

              {!isFree ? (
                <Button
                  variant={isOrganiser ? "primary" : "secondary"}
                  fullWidth
                  onClick={() => openCheckout(plan.code)}
                >
                  {authKind !== "user"
                    ? t("signInToUpgrade")
                    : isOrganiser
                      ? t("buyOrganiserCta")
                      : t("buyB2bCta")}
                </Button>
              ) : null}
            </article>
          );
        })}
      </div>

      <BottomSheet
        open={checkoutOpen}
        onClose={() => setCheckoutOpen(false)}
        title={t("checkoutTitle")}
        closeLabel={tCommon("close")}
      >
        <div className="space-y-4">
          {selectedPlanCode === "group_organiser_pass" ? (
            <div>
              <label
                htmlFor="checkout-journey-select"
                className="mb-1.5 block text-xs font-semibold text-[var(--text)]"
              >
                {t("selectJourneyLabel")}
              </label>
              {(journeysQuery.data?.items.length ?? 0) === 0 ? (
                <p className="text-xs text-[var(--danger-text)]">{t("noJourneysHint")}</p>
              ) : (
                <select
                  id="checkout-journey-select"
                  value={selectedJourneyId}
                  onChange={(ev) => setSelectedJourneyId(ev.target.value)}
                  className="min-h-[48px] w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 text-sm text-[var(--text)]"
                >
                  {journeysQuery.data?.items.map((item) => (
                    <option key={item.journey.id} value={item.journey.id}>
                      {item.journey.service_no} · {item.journey.service_date}
                    </option>
                  ))}
                </select>
              )}
            </div>
          ) : null}

          {checkoutError ? (
            <p role="alert" className="text-sm font-medium text-[var(--danger-text)]">
              {checkoutError}
            </p>
          ) : null}

          {!activeOrder ? (
            <Button
              variant="primary"
              fullWidth
              loading={checkoutMutation.isPending}
              disabled={
                selectedPlanCode === "group_organiser_pass" && !selectedJourneyId
              }
              onClick={() => checkoutMutation.mutate()}
            >
              {selectedPlanCode === "b2b_partner"
                ? t("createB2bOrderCta")
                : t("createOrderCta")}
            </Button>
          ) : activeOrder.checkout_mode === "sandbox" ? (
            <div className="space-y-3">
              <p className="text-xs text-[var(--text-muted)]">{t("sandboxNotice")}</p>
              <Button
                variant="primary"
                fullWidth
                loading={sandboxMutation.isPending}
                onClick={() => sandboxMutation.mutate(activeOrder.order_id)}
              >
                {selectedPlanCode === "b2b_partner"
                  ? t("sandboxCompleteB2bCta")
                  : t("sandboxCompleteCta")}
              </Button>
            </div>
          ) : (
            <p className="text-xs text-[var(--text)]">
              {t("razorpayNotice", { orderId: activeOrder.provider_order_id })}
            </p>
          )}
        </div>
      </BottomSheet>
    </div>
  );
}
