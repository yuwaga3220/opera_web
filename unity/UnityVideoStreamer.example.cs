// opera_web 用サンプル。Assets にコピーして使用してください。
// 必須: Connect 後に ReceiveLoop を動かす（Send だけだと十数秒で切断されます）。

using System;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;

public class UnityVideoStreamer : MonoBehaviour
{
    [Header("Server")]
    [SerializeField] private string serverUrl = "ws://127.0.0.1:8000/ws/unity-video";
    [SerializeField] private bool sendConfigOnConnect = true;

    [Header("Capture")]
    [SerializeField] private Camera targetCamera;
    [SerializeField] private int width = 640;
    [SerializeField] private int height = 480;
    [Range(1, 100)]
    [SerializeField] private int jpegQuality = 75;
    [SerializeField] private int targetFps = 20;

    private ClientWebSocket _ws;
    private CancellationTokenSource _cts;
    private RenderTexture _rt;
    private Texture2D _readTex;
    private Task _receiveTask;
    private volatile bool _connected;

    private void Reset()
    {
        targetCamera = Camera.main;
    }

    private async void Start()
    {
        if (targetCamera == null)
        {
            targetCamera = Camera.main;
        }

        _rt = new RenderTexture(width, height, 24, RenderTextureFormat.ARGB32);
        _readTex = new Texture2D(width, height, TextureFormat.RGB24, false);

        _cts = new CancellationTokenSource();
        await RunSessionAsync(_cts.Token);
    }

    private async Task RunSessionAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            _ws = new ClientWebSocket();
            try
            {
                await _ws.ConnectAsync(new Uri(serverUrl), ct);
                _connected = true;
                Debug.Log("[UnityVideo] Connected: " + serverUrl);

                _receiveTask = ReceiveLoopAsync(_ws, ct);

                if (sendConfigOnConnect)
                {
                    var cfg = $"{{\"type\":\"config\",\"width\":{width},\"height\":{height}}}";
                    await _ws.SendAsync(
                        new ArraySegment<byte>(Encoding.UTF8.GetBytes(cfg)),
                        WebSocketMessageType.Text,
                        true,
                        ct);
                }

                var interval = 1f / Mathf.Max(1, targetFps);
                while (_connected && _ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
                {
                    await SendOneFrameAsync(ct);
                    await Task.Delay(TimeSpan.FromSeconds(interval), ct);
                }
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[UnityVideo] session error: " + ex.Message);
            }
            finally
            {
                _connected = false;
                await CloseSocketAsync();
            }

            if (!ct.IsCancellationRequested)
            {
                Debug.Log("[UnityVideo] reconnect in 2s...");
                await Task.Delay(2000, ct);
            }
        }
    }

    private async Task ReceiveLoopAsync(ClientWebSocket ws, CancellationToken ct)
    {
        var buffer = new byte[16384];
        try
        {
            while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                var result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    _connected = false;
                    break;
                }
            }
        }
        catch (OperationCanceledException)
        {
            /* ok */
        }
        catch (Exception ex)
        {
            Debug.LogWarning("[UnityVideo] receive ended: " + ex.Message);
            _connected = false;
        }
    }

    private async Task SendOneFrameAsync(CancellationToken ct)
    {
        if (!_connected || _ws == null || _ws.State != WebSocketState.Open)
        {
            return;
        }

        try
        {
            var prevTarget = targetCamera.targetTexture;
            targetCamera.targetTexture = _rt;
            targetCamera.Render();
            targetCamera.targetTexture = prevTarget;

            var prevActive = RenderTexture.active;
            RenderTexture.active = _rt;
            _readTex.ReadPixels(new Rect(0, 0, width, height), 0, 0);
            _readTex.Apply();
            RenderTexture.active = prevActive;

            var jpg = ImageConversion.EncodeToJPG(_readTex, jpegQuality);
            if (jpg == null || jpg.Length == 0)
            {
                return;
            }

            await _ws.SendAsync(
                new ArraySegment<byte>(jpg),
                WebSocketMessageType.Binary,
                true,
                ct);
        }
        catch (Exception ex)
        {
            _connected = false;
            Debug.LogWarning("[UnityVideo] send failed: " + ex.Message);
        }
    }

    private async Task CloseSocketAsync()
    {
        if (_ws == null)
        {
            return;
        }
        try
        {
            if (_ws.State == WebSocketState.Open)
            {
                await _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None);
            }
        }
        catch
        {
            /* ignore */
        }
        _ws.Dispose();
        _ws = null;
    }

    private async void OnDestroy()
    {
        _connected = false;
        _cts?.Cancel();
        await CloseSocketAsync();
        if (_rt != null)
        {
            _rt.Release();
        }
        if (_readTex != null)
        {
            Destroy(_readTex);
        }
    }
}
