/**
 * Initial schema definitions aligned with apps/api M1 OpenAPI spec.
 * Regenerated via `pnpm --filter @saath/contracts generate` from openapi.json.
 */

export interface paths {
  "/healthz": {
    get: operations["healthz_healthz_get"];
  };
  "/readyz": {
    get: operations["readyz_readyz_get"];
  };
  "/v1/auth/anonymous": {
    post: operations["post_auth_anonymous_v1_auth_anonymous_post"];
  };
  "/v1/auth/otp/start": {
    post: operations["post_auth_otp_start_v1_auth_otp_start_post"];
  };
  "/v1/auth/otp/verify": {
    post: operations["post_auth_otp_verify_v1_auth_otp_verify_post"];
  };
  "/v1/auth/refresh": {
    post: operations["post_auth_refresh_v1_auth_refresh_post"];
  };
  "/v1/auth/logout": {
    post: operations["post_auth_logout_v1_auth_logout_post"];
  };
  "/v1/me": {
    get: operations["get_v1_me_v1_me_get"];
    patch: operations["patch_v1_me_v1_me_patch"];
  };
}

export interface components {
  schemas: {
    AnonymousAuthRequest: {
      turnstile: string;
    };
    AnonymousAuthResponse: {
      access: string;
      token_type?: "bearer";
      expires_in: number;
    };
    OtpStartRequest: {
      phone: string;
      channel?: "whatsapp" | "sms";
      turnstile: string;
      locale?: "en" | "hi";
    };
    OtpStartResponse: {
      request_id: string;
      resend_after: number;
    };
    OtpVerifyRequest: {
      request_id: string;
      code: string;
    };
    UserProfile: {
      id: string;
      display_alias?: string | null;
      gender_self: "female" | "male" | "other" | "undisclosed";
      locale: "en" | "hi";
      women_only_default: boolean;
      reliability_accepted: number;
      reliability_completed: number;
      status: "active" | "restricted" | "banned" | "deleted";
      created_at: string;
    };
    OtpVerifyResponse: {
      access: string;
      refresh: string;
      expires_in: number;
      user: components["schemas"]["UserProfile"];
    };
    RefreshRequest: {
      refresh: string;
    };
    TokenPairResponse: {
      access: string;
      refresh: string;
      expires_in: number;
    };
    LogoutResponse: {
      ok?: boolean;
    };
    UpdateMeRequest: {
      locale?: "en" | "hi" | null;
      women_only_default?: boolean | null;
      display_alias?: string | null;
      gender_self?: "female" | "male" | "other" | "undisclosed" | null;
    };
    ProblemFieldError: {
      field: string;
      message: string;
      type: string;
    };
    ProblemDetail: {
      type?: string;
      title: string;
      status: number;
      detail: string;
      code: string;
      errors?: components["schemas"]["ProblemFieldError"][] | null;
    };
    HealthResponse: {
      status: string;
    };
    ReadyChecks: {
      postgres: string;
      redis: string;
    };
    ReadyResponse: {
      status: string;
      checks: components["schemas"]["ReadyChecks"];
    };
  };
}

export interface operations {
  healthz_healthz_get: {
    responses: {
      200: {
        content: {
          "application/json": components["schemas"]["HealthResponse"];
        };
      };
    };
  };
  readyz_readyz_get: {
    responses: {
      200: {
        content: {
          "application/json": components["schemas"]["ReadyResponse"];
        };
      };
      503: {
        content: {
          "application/problem+json": components["schemas"]["ProblemDetail"];
        };
      };
    };
  };
  post_auth_anonymous_v1_auth_anonymous_post: {
    requestBody: {
      content: {
        "application/json": components["schemas"]["AnonymousAuthRequest"];
      };
    };
    responses: {
      200: {
        content: {
          "application/json": components["schemas"]["AnonymousAuthResponse"];
        };
      };
      403: {
        content: {
          "application/problem+json": components["schemas"]["ProblemDetail"];
        };
      };
      422: {
        content: {
          "application/problem+json": components["schemas"]["ProblemDetail"];
        };
      };
      429: {
        content: {
          "application/problem+json": components["schemas"]["ProblemDetail"];
        };
      };
    };
  };
  post_auth_otp_start_v1_auth_otp_start_post: {
    requestBody: {
      content: {
        "application/json": components["schemas"]["OtpStartRequest"];
      };
    };
    responses: {
      200: {
        content: {
          "application/json": components["schemas"]["OtpStartResponse"];
        };
      };
      403: {
        content: {
          "application/problem+json": components["schemas"]["ProblemDetail"];
        };
      };
      422: {
        content: {
          "application/problem+json": components["schemas"]["ProblemDetail"];
        };
      };
      429: {
        content: {
          "application/problem+json": components["schemas"]["ProblemDetail"];
        };
      };
    };
  };
  post_auth_otp_verify_v1_auth_otp_verify_post: {
    requestBody: {
      content: {
        "application/json": components["schemas"]["OtpVerifyRequest"];
      };
    };
    responses: {
      200: {
        content: {
          "application/json": components["schemas"]["OtpVerifyResponse"];
        };
      };
      401: {
        content: {
          "application/problem+json": components["schemas"]["ProblemDetail"];
        };
      };
      403: {
        content: {
          "application/problem+json": components["schemas"]["ProblemDetail"];
        };
      };
      422: {
        content: {
          "application/problem+json": components["schemas"]["ProblemDetail"];
        };
      };
      429: {
        content: {
          "application/problem+json": components["schemas"]["ProblemDetail"];
        };
      };
    };
  };
  post_auth_refresh_v1_auth_refresh_post: {
    requestBody: {
      content: {
        "application/json": components["schemas"]["RefreshRequest"];
      };
    };
    responses: {
      200: {
        content: {
          "application/json": components["schemas"]["TokenPairResponse"];
        };
      };
      401: {
        content: {
          "application/problem+json": components["schemas"]["ProblemDetail"];
        };
      };
      403: {
        content: {
          "application/problem+json": components["schemas"]["ProblemDetail"];
        };
      };
      422: {
        content: {
          "application/problem+json": components["schemas"]["ProblemDetail"];
        };
      };
    };
  };
  post_auth_logout_v1_auth_logout_post: {
    responses: {
      200: {
        content: {
          "application/json": components["schemas"]["LogoutResponse"];
        };
      };
      401: {
        content: {
          "application/problem+json": components["schemas"]["ProblemDetail"];
        };
      };
      403: {
        content: {
          "application/problem+json": components["schemas"]["ProblemDetail"];
        };
      };
    };
  };
  get_v1_me_v1_me_get: {
    responses: {
      200: {
        content: {
          "application/json": components["schemas"]["UserProfile"];
        };
      };
      401: {
        content: {
          "application/problem+json": components["schemas"]["ProblemDetail"];
        };
      };
      403: {
        content: {
          "application/problem+json": components["schemas"]["ProblemDetail"];
        };
      };
      404: {
        content: {
          "application/problem+json": components["schemas"]["ProblemDetail"];
        };
      };
    };
  };
  patch_v1_me_v1_me_patch: {
    requestBody: {
      content: {
        "application/json": components["schemas"]["UpdateMeRequest"];
      };
    };
    responses: {
      200: {
        content: {
          "application/json": components["schemas"]["UserProfile"];
        };
      };
      401: {
        content: {
          "application/problem+json": components["schemas"]["ProblemDetail"];
        };
      };
      403: {
        content: {
          "application/problem+json": components["schemas"]["ProblemDetail"];
        };
      };
      404: {
        content: {
          "application/problem+json": components["schemas"]["ProblemDetail"];
        };
      };
      422: {
        content: {
          "application/problem+json": components["schemas"]["ProblemDetail"];
        };
      };
    };
  };
}
