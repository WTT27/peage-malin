#!/usr/bin/env python3
# Remote commands to the e-208 (charge stop / start), the same way as the MyPeugeot app: a one-time "OTP" activation
# (SMS code + the MyPeugeot PIN), then commands sent over Stellantis's MQTT server. Called by car/charge.mjs, which does
# everything else (Peugeot login, tokens, schedule, alerts). Runs in the private environment
# ~/.config/peage-malin-car/venv (pycryptodome, paho-mqtt, requests).
#
# The OTP code (inWebo protocol) is a reviewed copy from the community project homeassistant-stellantis-vehicles
# (MIT licence): car/stellotp/.
#
# Input: one JSON object on stdin (so that no secret ever appears in the process list). Output: JSON lines on stdout.
#   {"cmd": "activate", "sms": "...", "pin": "....", "device_id": "..."}
#   {"cmd": "otp"}                                 → {"otp": "..."}
#   {"cmd": "send", "token": "...", "customer_id": "...", "vin": "...", "service": "/VehCharge", "params": {...}, "wait": 90}
#   (no "service": connection test only)
import json
import os
import random
import socket
import sys
import time
import types
import uuid
from datetime import datetime, timezone

DIR = os.path.join(os.path.expanduser('~'), '.config', 'peage-malin-car')
OTP_FILE = os.path.join(DIR, 'otp.pickle')


def out(**kw):
    print(json.dumps(kw), flush=True)


def otp_module():
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    from stellotp import otp  # noqa: E402  (reviewed copy, see car/stellotp/LICENSE.txt)
    return otp


def save(o, otp):
    otp.save_otp(o, OTP_FILE)
    os.chmod(OTP_FILE, 0o600)


def activate(req):
    otp = otp_module()
    o = otp.Otp('bb8e981582b0f31353108fb020bead1c', device_id=req['device_id'])
    o.smsCode = req['sms']
    o.codepin = req['pin']
    if not o.activation_start():
        out(ok=False, error='activation refusée au démarrage')
        return
    r = o.activation_finalyze()
    if r != 0:
        out(ok=False, error=f'activation refusée : {r}')
        return
    save(o, otp)
    out(ok=True)


def get_otp():
    otp = otp_module()
    o = otp.load_otp(OTP_FILE)
    if o is None:
        out(ok=False, error='pas d\'activation : lancer  node car/charge.mjs setup')
        return
    code = o.get_otp_code()
    save(o, otp)
    out(ok=code is not None, otp=code)


def send(req):
    import paho.mqtt.client as mqtt

    class Client(mqtt.Client):
        # some Stellantis MQTT servers drop TCP packets above 1456 bytes (TLS handshake fails): smaller segments
        def _create_socket_connection(self):
            infos = socket.getaddrinfo(self._host, self._port, 0, socket.SOCK_STREAM)
            random.shuffle(infos)
            err = None
            for af, st, pr, _, sa in infos:
                s = None
                try:
                    s = socket.socket(af, st, pr)
                    s.setsockopt(socket.IPPROTO_TCP, socket.TCP_MAXSEG, 1456)
                    s.settimeout(self._connect_timeout)
                    s.connect(sa)
                    return s
                except OSError as e:
                    err = e
                    if s:
                        s.close()
            raise err or OSError('no address')

    cid, corr = req['customer_id'], uuid.uuid4().hex + datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')[:-3]
    st = types.SimpleNamespace(done=False, sent=False, codes=[])
    c = Client(mqtt.CallbackAPIVersion.VERSION2, clean_session=True, protocol=mqtt.MQTTv311)
    c.tls_set()
    c.username_pw_set('IMA_OAUTH_ACCESS_TOKEN', req['token'])

    def on_connect(cl, ud, flags, rc, props=None):
        if rc != 0:
            out(event='connect_refused', code=str(rc))
            st.done = True
            return
        cl.subscribe('psa/RemoteServices/to/cid/' + cid + '/#', qos=0)

    def on_subscribe(cl, ud, mid, rcs, props=None):
        if not req.get('service'):              # connection test only
            out(event='connected')
            st.done = True
            return
        if st.sent:
            return
        st.sent = True
        data = {'access_token': req['token'], 'customer_id': cid, 'correlation_id': corr,
                'req_date': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'vin': req['vin'],
                'req_parameters': req['params']}
        cl.publish('psa/RemoteServices/from/cid/' + cid + req['service'], json.dumps(data), qos=0)
        out(event='sent')

    def on_message(cl, ud, msg):
        try:
            d = json.loads(msg.payload)
        except ValueError:
            return
        if d.get('correlation_id') not in (None, corr):
            return
        code = str(d.get('return_code', d.get('process_code', '')))
        st.codes.append(code)
        out(event='reply', code=code, reason=d.get('reason'), resp=d.get('resp_data'))
        if code and code not in ('900', '901', '903'):
            st.done = True                      # final answer (0/1 = done, 300/400/500/113 = failure)

    c.on_connect, c.on_subscribe, c.on_message = on_connect, on_subscribe, on_message
    try:
        c.connect('mwa.mpsa.com', 8885, 120)
    except Exception as e:  # noqa: BLE001
        out(event='connect_error', error=str(e))
        return
    c.loop_start()
    t_end = time.time() + int(req.get('wait', 90))
    while not st.done and time.time() < t_end:
        time.sleep(0.5)
    c.loop_stop()
    c.disconnect()
    out(event='end', codes=st.codes, sent=st.sent)


if __name__ == '__main__':
    r = json.loads(sys.stdin.read() or '{}')
    try:
        {'activate': activate, 'otp': lambda _: get_otp(), 'send': send}[r.get('cmd')](r)
    except Exception as e:  # noqa: BLE001
        out(ok=False, error=f'{type(e).__name__}: {e}')
