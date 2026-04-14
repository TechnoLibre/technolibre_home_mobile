package ca.erplibre.home;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.jcraft.jsch.Channel;
import com.jcraft.jsch.ChannelExec;
import com.jcraft.jsch.HostKey;
import com.jcraft.jsch.HostKeyRepository;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.Session;
import com.jcraft.jsch.UserInfo;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

@CapacitorPlugin(name = "SshPlugin")
public class SshPlugin extends Plugin {

    private Session session;

    /**
     * Returns the app-private known_hosts file for SSH host key verification.
     * Uses Trust-On-First-Use (TOFU): accepts and stores key on first connect,
     * verifies on subsequent connections.
     */
    private File getKnownHostsFile() {
        File sshDir = new File(getContext().getFilesDir(), ".ssh");
        if (!sshDir.exists()) {
            sshDir.mkdirs();
        }
        return new File(sshDir, "known_hosts");
    }

    @PluginMethod
    public void connect(PluginCall call) {
        String host = call.getString("host");
        int port = call.getInt("port", 22);
        String username = call.getString("username");
        String authType = call.getString("authType", "password");
        String credential = call.getString("credential");
        String passphrase = call.getString("passphrase", "");

        if (host == null || username == null || credential == null) {
            call.reject("Missing required parameters: host, username, credential");
            return;
        }

        new Thread(() -> {
            try {
                JSch jsch = new JSch();

                // Load or create known_hosts for TOFU host key verification
                File knownHosts = getKnownHostsFile();
                if (!knownHosts.exists()) {
                    knownHosts.createNewFile();
                }
                jsch.setKnownHosts(knownHosts.getAbsolutePath());

                if ("key".equals(authType)) {
                    byte[] keyBytes = credential.getBytes(StandardCharsets.UTF_8);
                    byte[] passphraseBytes = (passphrase != null && !passphrase.isEmpty())
                        ? passphrase.getBytes(StandardCharsets.UTF_8)
                        : null;
                    jsch.addIdentity("ssh-key", keyBytes, null, passphraseBytes);
                }

                session = jsch.getSession(username, host, port);

                if ("password".equals(authType)) {
                    session.setPassword(credential);
                }

                // TOFU via UserInfo: auto-accept unknown hosts, reject changed keys.
                // JSch calls promptYesNo when host is unknown (StrictHostKeyChecking=ask).
                // After connect, the key is automatically persisted to known_hosts.
                java.util.Properties config = new java.util.Properties();
                config.put("StrictHostKeyChecking", "ask");
                session.setConfig(config);
                session.setUserInfo(new TofuUserInfo());

                session.setTimeout(30000);
                session.connect(30000);

                JSObject result = new JSObject();
                if (session.getHostKey() != null) {
                    result.put("hostKeyFingerprint", session.getHostKey().getFingerPrint(jsch));
                }
                call.resolve(result);
            } catch (com.jcraft.jsch.JSchException e) {
                String msg = e.getMessage();
                if (msg != null && (msg.contains("HostKey") || msg.contains("host key")
                        || msg.contains("changed"))) {
                    call.reject("SSH host key verification failed. The server's key may have "
                        + "changed — possible MITM attack. Use clearKnownHost() to remove "
                        + "the old key if the change is expected.", e);
                } else {
                    call.reject("SSH connection failed: " + msg, e);
                }
            } catch (Exception e) {
                call.reject("SSH connection failed: " + e.getMessage(), e);
            }
        }).start();
    }

    @PluginMethod
    public void clearKnownHost(PluginCall call) {
        String host = call.getString("host");
        if (host == null) {
            call.reject("Missing required parameter: host");
            return;
        }

        try {
            JSch jsch = new JSch();
            File knownHosts = getKnownHostsFile();
            if (knownHosts.exists()) {
                jsch.setKnownHosts(knownHosts.getAbsolutePath());
                jsch.getHostKeyRepository().remove(host, "ssh-rsa");
                jsch.getHostKeyRepository().remove(host, "ecdsa-sha2-nistp256");
                jsch.getHostKeyRepository().remove(host, "ssh-ed25519");
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to clear known host: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void execute(PluginCall call) {
        String command = call.getString("command");

        if (command == null) {
            call.reject("Missing required parameter: command");
            return;
        }

        if (session == null || !session.isConnected()) {
            call.reject("No active SSH session. Call connect() first.");
            return;
        }

        new Thread(() -> {
            ChannelExec channel = null;
            try {
                channel = (ChannelExec) session.openChannel("exec");
                channel.setCommand(command);
                channel.setPty(false);

                InputStream stdout = channel.getInputStream();
                InputStream stderr = channel.getErrStream();

                channel.connect();

                // Stream stdout and stderr in separate threads
                final ChannelExec finalChannel = channel;
                Thread stdoutThread = new Thread(() -> streamOutput(stdout, "stdout", finalChannel));
                Thread stderrThread = new Thread(() -> streamOutput(stderr, "stderr", finalChannel));

                stdoutThread.start();
                stderrThread.start();

                stdoutThread.join();
                stderrThread.join();

                int exitCode = channel.getExitStatus();

                JSObject result = new JSObject();
                result.put("exitCode", exitCode);
                call.resolve(result);

            } catch (Exception e) {
                call.reject("SSH command execution failed: " + e.getMessage(), e);
            } finally {
                if (channel != null && channel.isConnected()) {
                    channel.disconnect();
                }
            }
        }).start();
    }

    private void streamOutput(InputStream stream, String streamName, Channel channel) {
        try {
            BufferedReader reader = new BufferedReader(
                new InputStreamReader(stream, StandardCharsets.UTF_8)
            );
            String line;
            while (!channel.isClosed() || reader.ready()) {
                while ((line = reader.readLine()) != null) {
                    JSObject data = new JSObject();
                    data.put("line", line);
                    data.put("stream", streamName);
                    notifyListeners("sshOutput", data);
                }
                if (!channel.isClosed()) {
                    Thread.sleep(50);
                }
            }
            // Drain any remaining output after channel closes
            while ((line = reader.readLine()) != null) {
                JSObject data = new JSObject();
                data.put("line", line);
                data.put("stream", streamName);
                notifyListeners("sshOutput", data);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (Exception e) {
            JSObject data = new JSObject();
            data.put("line", "[stream error: " + e.getMessage() + "]");
            data.put("stream", streamName);
            notifyListeners("sshOutput", data);
        }
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        if (session != null && session.isConnected()) {
            session.disconnect();
        }
        session = null;
        call.resolve();
    }

    /**
     * Trust-On-First-Use (TOFU) UserInfo implementation for JSch.
     * - promptYesNo is called when host key is unknown → returns true (accept + store)
     * - If the host key has CHANGED, JSch rejects before calling promptYesNo,
     *   so this only auto-accepts genuinely new hosts.
     */
    private static class TofuUserInfo implements UserInfo {
        @Override
        public String getPassphrase() { return null; }
        @Override
        public String getPassword() { return null; }
        @Override
        public boolean promptPassword(String message) { return false; }
        @Override
        public boolean promptPassphrase(String message) { return false; }
        @Override
        public boolean promptYesNo(String message) {
            // Auto-accept unknown host keys (TOFU).
            // JSch persists the key to known_hosts automatically.
            return true;
        }
        @Override
        public void showMessage(String message) { }
    }
}
