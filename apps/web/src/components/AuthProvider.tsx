"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ToastProvider, useToast } from "@saath/ui";
import type { UserProfile } from "@saath/contracts";
import { createBrowserApiClient } from "@/lib/api";
import { publicEnv } from "@/lib/env";
import { makeQueryClient } from "@/lib/query-client";
import { PhoneOtpSheet } from "./PhoneOtpSheet";

export type AuthKind = "uninitialized" | "anon" | "user";

const ACCESS_STORAGE_KEY = "saath_access";
const REFRESH_STORAGE_KEY = "saath_refresh";
const KIND_STORAGE_KEY = "saath_auth_kind";

export function isJwtExpired(token: string, leewaySeconds = 15): boolean {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) {
    return false;
  }
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=");
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    if (typeof payload.exp !== "number") {
      return false;
    }
    return payload.exp <= Math.floor(Date.now() / 1000) + leewaySeconds;
  } catch {
    return false;
  }
}

interface AuthContextValue {
  authKind: AuthKind;
  accessToken: string | null;
  user: UserProfile | null;
  apiClient: ReturnType<typeof createBrowserApiClient>;
  ensureAuth: (turnstileToken?: string) => Promise<string | null>;
  openOtpModal: () => void;
  closeOtpModal: () => void;
  setUserSession: (payload: {
    access: string;
    refresh: string;
    user: UserProfile;
  }) => void;
  setUser: (user: UserProfile | null) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function InnerAuthProvider({ children }: { children: ReactNode }) {
  const tProfile = useTranslations("profile");
  const { showToast } = useToast();
  const [authKind, setAuthKind] = useState<AuthKind>("uninitialized");
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [otpOpen, setOtpOpen] = useState(false);

  const accessRef = useRef<string | null>(null);
  const refreshRef = useRef<string | null>(null);
  const kindRef = useRef<AuthKind>("uninitialized");
  const anonBootstrapRef = useRef<Promise<string | null> | null>(null);
  const refreshPromiseRef = useRef<Promise<string | null> | null>(null);

  const persistTokens = useCallback(
    (kind: AuthKind, access: string | null, refresh: string | null) => {
      kindRef.current = kind;
      accessRef.current = access;
      refreshRef.current = refresh;
      setAccessToken(access);
      setAuthKind(kind);

      try {
        if (access) {
          window.sessionStorage.setItem(ACCESS_STORAGE_KEY, access);
          window.sessionStorage.setItem(KIND_STORAGE_KEY, kind);
        } else {
          window.sessionStorage.removeItem(ACCESS_STORAGE_KEY);
          window.sessionStorage.removeItem(KIND_STORAGE_KEY);
        }
        if (refresh) {
          window.localStorage.setItem(REFRESH_STORAGE_KEY, refresh);
        } else {
          window.localStorage.removeItem(REFRESH_STORAGE_KEY);
        }
      } catch {
        // Ignore storage errors in restricted environments
      }
    },
    []
  );

  const refreshTokens = useCallback(async (): Promise<string | null> => {
    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current;
    }

    const promise = (async (): Promise<string | null> => {
      const currentRefresh = refreshRef.current;
      if (!currentRefresh) {
        return null;
      }

      const tempClient = createBrowserApiClient({
        getAccessToken: () => null,
        refreshTokens: async () => null,
      });
      const { data, error } = await tempClient.POST("/v1/auth/refresh", {
        body: { refresh: currentRefresh },
      });

      if (error || !data) {
        persistTokens("uninitialized", null, null);
        setUser(null);
        return null;
      }

      persistTokens("user", data.access, data.refresh);
      return data.access;
    })().finally(() => {
      refreshPromiseRef.current = null;
    });

    refreshPromiseRef.current = promise;
    return promise;
  }, [persistTokens]);

  const apiClient = useMemo(
    () =>
      createBrowserApiClient({
        getAccessToken: () => {
          const token = accessRef.current;
          if (!token) {
            return null;
          }
          if (kindRef.current === "anon" && isJwtExpired(token)) {
            persistTokens("uninitialized", null, null);
            return null;
          }
          return token;
        },
        refreshTokens,
      }),
    [persistTokens, refreshTokens]
  );

  const ensureAuth = useCallback(
    async (providedTurnstile?: string): Promise<string | null> => {
      if (accessRef.current) {
        if (kindRef.current === "anon" && isJwtExpired(accessRef.current)) {
          persistTokens("uninitialized", null, null);
        } else {
          return accessRef.current;
        }
      }
      if (refreshRef.current) {
        const refreshed = await refreshTokens();
        if (refreshed) {
          return refreshed;
        }
      }

      const turnstileToken =
        publicEnv.NEXT_PUBLIC_TURNSTILE_MODE === "fake"
          ? "fake-turnstile-token"
          : providedTurnstile ?? null;
      if (!turnstileToken) {
        return null;
      }

      if (!anonBootstrapRef.current) {
        anonBootstrapRef.current = (async () => {
          try {
            const { data } = await apiClient.POST("/v1/auth/anonymous", {
              body: { turnstile: turnstileToken },
            });
            if (data?.access) {
              persistTokens("anon", data.access, null);
              return data.access;
            }
            return null;
          } catch {
            return null;
          } finally {
            anonBootstrapRef.current = null;
          }
        })();
      }
      return anonBootstrapRef.current;
    },
    [apiClient, persistTokens, refreshTokens]
  );

  useEffect(() => {
    try {
      const storedAccess = window.sessionStorage.getItem(ACCESS_STORAGE_KEY);
      const storedKind = window.sessionStorage.getItem(KIND_STORAGE_KEY) as AuthKind | null;
      const storedRefresh = window.localStorage.getItem(REFRESH_STORAGE_KEY);
      refreshRef.current = storedRefresh;

      if (storedAccess && (storedKind === "anon" || storedKind === "user")) {
        if (isJwtExpired(storedAccess)) {
          window.sessionStorage.removeItem(ACCESS_STORAGE_KEY);
          window.sessionStorage.removeItem(KIND_STORAGE_KEY);
          if (storedRefresh) {
            void refreshTokens();
          } else {
            void ensureAuth();
          }
        } else {
          kindRef.current = storedKind;
          accessRef.current = storedAccess;
          setAccessToken(storedAccess);
          setAuthKind(storedKind);
        }
      } else if (storedRefresh) {
        void refreshTokens();
      } else {
        void ensureAuth();
      }
    } catch {
      void ensureAuth();
    }
  }, [ensureAuth, refreshTokens]);

  const setUserSession = useCallback(
    (payload: { access: string; refresh: string; user: UserProfile }) => {
      persistTokens("user", payload.access, payload.refresh);
      setUser(payload.user);
    },
    [persistTokens]
  );

  const logout = useCallback(async () => {
    try {
      if (accessRef.current && authKind === "user") {
        await apiClient.POST("/v1/auth/logout");
      }
    } catch {
      // Clear local session even if server call fails
    }
    persistTokens("uninitialized", null, null);
    setUser(null);
    showToast({ variant: "info", message: tProfile("loggedOutToast") });
  }, [apiClient, authKind, persistTokens, showToast, tProfile]);

  return (
    <AuthContext.Provider
      value={{
        authKind,
        accessToken,
        user,
        apiClient,
        ensureAuth,
        openOtpModal: () => setOtpOpen(true),
        closeOtpModal: () => setOtpOpen(false),
        setUserSession,
        setUser,
        logout,
      }}
    >
      {children}
      <PhoneOtpSheet open={otpOpen} onClose={() => setOtpOpen(false)} />
    </AuthContext.Provider>
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => makeQueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <InnerAuthProvider>{children}</InnerAuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used inside AuthProvider");
  }
  return ctx;
}
