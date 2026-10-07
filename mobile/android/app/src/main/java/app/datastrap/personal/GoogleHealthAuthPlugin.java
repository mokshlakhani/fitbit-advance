package app.datastrap.personal;

import android.app.Activity;
import android.app.PendingIntent;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.identity.AuthorizationClient;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.ClearTokenRequest;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.Scope;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Google sign-in for the Google Health API, done by Google Play services on
 * the phone. Returns short-lived access tokens; Play services keeps the grant
 * and hands out fresh tokens silently, so the app never stores a password or
 * refresh token. Needs an Android OAuth client (this package name + signing
 * certificate SHA-1) in the same Google Cloud project as the API.
 */
@CapacitorPlugin(name = "GoogleHealthAuth")
public class GoogleHealthAuthPlugin extends Plugin {

    private static final List<Scope> SCOPES = Arrays.asList(
        new Scope("https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly"),
        new Scope("https://www.googleapis.com/auth/googlehealth.sleep.readonly"),
        new Scope("https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly"),
        new Scope("https://www.googleapis.com/auth/googlehealth.profile.readonly"),
        new Scope("https://www.googleapis.com/auth/googlehealth.settings.readonly")
    );

    // Asked for only when someone first logs a workout (Log +), so signing in
    // to read never shows a "write" permission.
    private static final Scope WRITE_SCOPE = new Scope("https://www.googleapis.com/auth/googlehealth.activity_and_fitness.writeonly");

    private ActivityResultLauncher<IntentSenderRequest> consentLauncher;
    private PluginCall consentCall;

    @Override
    public void load() {
        consentLauncher = getActivity().getActivityResultRegistry().register(
            "datastrap-google-consent",
            new ActivityResultContracts.StartIntentSenderForResult(),
            result -> {
                PluginCall call = consentCall;
                consentCall = null;
                if (call == null) return;
                if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
                    call.reject("Sign-in was cancelled.", "CANCELED");
                    return;
                }
                try {
                    resolveToken(call, client().getAuthorizationResultFromIntent(result.getData()));
                } catch (ApiException e) {
                    call.reject("Google sign-in failed: " + e.getStatusCode(), "AUTH_FAILED", e);
                }
            });
    }

    private AuthorizationClient client() {
        return Identity.getAuthorizationClient(getActivity());
    }

    /**
     * {interactive: boolean, write: boolean} -> {accessToken}. Without interactive,
     * rejects NEEDS_CONSENT instead of showing a screen. write adds permission to
     * log workouts.
     */
    @PluginMethod
    public void authorize(PluginCall call) {
        boolean interactive = Boolean.TRUE.equals(call.getBoolean("interactive", false));
        List<Scope> scopes = SCOPES;
        if (Boolean.TRUE.equals(call.getBoolean("write", false))) {
            scopes = new ArrayList<>(SCOPES);
            scopes.add(WRITE_SCOPE);
        }
        AuthorizationRequest request = AuthorizationRequest.builder().setRequestedScopes(scopes).build();
        client().authorize(request)
            .addOnSuccessListener(result -> {
                if (!result.hasResolution()) {
                    resolveToken(call, result);
                    return;
                }
                if (!interactive) {
                    call.reject("Google sign-in is needed.", "NEEDS_CONSENT");
                    return;
                }
                if (consentCall != null) {
                    call.reject("Sign-in is already in progress.", "BUSY");
                    return;
                }
                PendingIntent intent = result.getPendingIntent();
                consentCall = call;
                consentLauncher.launch(new IntentSenderRequest.Builder(intent.getIntentSender()).build());
            })
            .addOnFailureListener(e -> call.reject("Google sign-in failed: " + e.getMessage(), "AUTH_FAILED", e));
    }

    /** {token}: forget a token the API rejected, so the next authorize() returns a fresh one. */
    @PluginMethod
    public void clearToken(PluginCall call) {
        String token = call.getString("token");
        if (token == null) {
            call.resolve();
            return;
        }
        client().clearToken(ClearTokenRequest.builder().setToken(token).build())
            .addOnSuccessListener(unused -> call.resolve())
            .addOnFailureListener(e -> call.reject(e.getMessage(), "CLEAR_FAILED", e));
    }

    /** Forget the current token. To revoke access entirely, use myaccount.google.com/permissions. */
    @PluginMethod
    public void signOut(PluginCall call) {
        AuthorizationRequest request = AuthorizationRequest.builder().setRequestedScopes(SCOPES).build();
        client().authorize(request)
            .addOnSuccessListener(result -> {
                String token = result.getAccessToken();
                if (token == null) {
                    call.resolve();
                    return;
                }
                client().clearToken(ClearTokenRequest.builder().setToken(token).build())
                    .addOnCompleteListener(t -> call.resolve());
            })
            .addOnFailureListener(e -> call.resolve());
    }

    private void resolveToken(PluginCall call, AuthorizationResult result) {
        String token = result.getAccessToken();
        if (token == null) {
            call.reject("Google returned no access token.", "AUTH_FAILED");
            return;
        }
        JSObject out = new JSObject();
        out.put("accessToken", token);
        call.resolve(out);
    }
}
