package ca.erplibre.home;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.jcraft.jsch.Channel;
import com.jcraft.jsch.ChannelExec;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.Session;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

@CapacitorPlugin(name = "SshPlugin")
public class SshPlugin extends Plugin {

    private Session session;

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

                // Disable strict host key checking for mobile deployments
                java.util.Properties config = new java.util.Properties();
                config.put("StrictHostKeyChecking", "no");
                session.setConfig(config);

                session.setTimeout(30000);
                session.connect(30000);

                call.resolve();
            } catch (Exception e) {
                call.reject("SSH connection failed: " + e.getMessage(), e);
            }
        }).start();
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
}
