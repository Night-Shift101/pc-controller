#!/usr/bin/env python3
import sys
import json
import threading
from typing import Any, Dict, List, Optional, Tuple, Union

from cuesdk import (
    CueSdk,
    CorsairDeviceFilter,
    CorsairDeviceType,
    CorsairError,
    CorsairSessionState,
    CorsairLedColor,
)

Json = Dict[str, Any]


def json_out(obj: Json, code: int = 0):
    print(json.dumps(obj, ensure_ascii=False))
    sys.exit(code)


def connect_sdk(timeout_sec: float = 5.0) -> CueSdk:
    sdk = CueSdk()
    ready = threading.Event()

    def on_state(evt):
        if getattr(evt, 'state', None) == CorsairSessionState.CSS_Connected:
            ready.set()

    err = sdk.connect(on_state)
    if err != CorsairError.CE_Success:
        json_out({'error': 'Failed to connect to iCUE. Ensure iCUE is running and SDK is enabled.', 'code': str(err)}, 1)

    ready.wait(timeout_sec)
    return sdk


def get_devices_with_indexes(sdk: CueSdk) -> Tuple[List[Json], Dict[int, str], Dict[str, int]]:
    devices, err = sdk.get_devices(CorsairDeviceFilter(CorsairDeviceType.CDT_All))
    if err != CorsairError.CE_Success:
        json_out({'error': 'Could not enumerate devices', 'code': str(err)}, 1)

    result: List[Json] = []
    index_to_id: Dict[int, str] = {}
    id_to_index: Dict[str, int] = {}

    for idx, d in enumerate(devices or []):
        dev_id = getattr(d, 'device_id', None)
        info, ierr = sdk.get_device_info(dev_id)
        if ierr != CorsairError.CE_Success or info is None:
            continue
        dtype = getattr(info, 'type', None)
        dtype_str = getattr(dtype, 'name', None) if dtype is not None else str(dtype)
        entry = {
            'index': idx,
            'device_id': dev_id,
            'type': dtype_str,
            'model': getattr(info, 'model', None),
            'serial': getattr(info, 'serial', None),
            'led_count': getattr(info, 'led_count', None),
            'channel_count': getattr(info, 'channel_count', None),
        }
        result.append(entry)
        if isinstance(dev_id, str):
            index_to_id[idx] = dev_id
            id_to_index[dev_id] = idx

    return result, index_to_id, id_to_index


def is_int_str(s: str) -> bool:
    try:
        int(s)
        return True
    except Exception:
        return False


def to_device_id(sdk: CueSdk, ident: Union[int, str]) -> str:
    # Convert numeric index to device_id (UUID); pass UUID through
    _, index_to_id, id_to_index = get_devices_with_indexes(sdk)
    if isinstance(ident, int):
        if ident in index_to_id:
            return index_to_id[ident]
        json_out({'error': f'Index out of range: {ident}'}, 1)
    # ident is str
    if is_int_str(ident):
        idx = int(ident)
        if idx in index_to_id:
            return index_to_id[idx]
        json_out({'error': f'Index out of range: {ident}'}, 1)
    if ident in id_to_index:
        return ident  # already a valid UUID for a device
    json_out({'error': f'Unknown device identifier: {ident}'}, 1)
    return ""  # unreachable


def list_devices_cmd():
    sdk = connect_sdk()
    devices, _, _ = get_devices_with_indexes(sdk)
    json_out({'ok': True, 'devices': devices})


def get_led_positions(sdk: CueSdk, ident: Union[int, str]):
    # Prefer index variant if available; otherwise convert to device_id and use id variant
    if isinstance(ident, int):
        fn = getattr(sdk, 'get_led_positions_by_device_index', None)
        if callable(fn):
            res = fn(ident)
            return (res[0], res[1]) if isinstance(res, tuple) else (res, CorsairError.CE_Success)
    dev_id = to_device_id(sdk, ident)
    for name in ['get_led_positions_by_device_id', 'get_led_positions']:
        fn = getattr(sdk, name, None)
        if callable(fn):
            res = fn(dev_id)
            return (res[0], res[1]) if isinstance(res, tuple) else (res, CorsairError.CE_Success)
    json_out({'error': 'No LED position API available in cuesdk'}, 1)
    return None, CorsairError.CE_Unknown


def set_colors_buffer(sdk: CueSdk, ident: Union[int, str], colors: List[CorsairLedColor]):
    # Prefer index variant if available; otherwise convert to device_id and use id/global variant
    if isinstance(ident, int):
        fn = getattr(sdk, 'set_led_colors_buffer_by_device_index', None)
        if callable(fn):
            try:
                return fn(ident, colors)
            except TypeError:
                pass  # fall through to id-based
    dev_id = to_device_id(sdk, ident)
    for name in ['set_led_colors_buffer_by_device_id', 'set_led_colors_buffer']:
        fn = getattr(sdk, name, None)
        if callable(fn):
            try:
                return fn(dev_id, colors)
            except TypeError:
                return fn(colors)
    return CorsairError.CE_Unknown


def flush_colors(sdk: CueSdk):
    fn = getattr(sdk, 'set_led_colors_flush_buffer', None)
    if callable(fn):
        return fn()
    return CorsairError.CE_Success


def list_leds_cmd(device_identifier: str):
    sdk = connect_sdk()
    ident: Union[int, str] = int(device_identifier) if is_int_str(device_identifier) else device_identifier
    positions, err = get_led_positions(sdk, ident)
    if err != CorsairError.CE_Success or positions is None:
        json_out({'error': 'Could not get LED positions', 'code': str(err), 'device': device_identifier}, 1)
    leds = []
    for lp in getattr(positions, 'led_positions', []) or []:
        leds.append({
            'led_id': getattr(lp, 'led_id', None),
            'top': getattr(lp, 'top', None),
            'left': getattr(lp, 'left', None),
            'height': getattr(lp, 'height', None),
            'width': getattr(lp, 'width', None),
        })
    json_out({'ok': True, 'device': device_identifier, 'leds': leds})


def set_color_cmd(r: int, g: int, b: int, device_identifier: Optional[str] = None):
    sdk = connect_sdk()
    targets: List[Union[int, str]] = []
    if device_identifier:
        targets = [int(device_identifier) if is_int_str(device_identifier) else device_identifier]
    else:
        devices, _, _ = get_devices_with_indexes(sdk)
        targets = [d['index'] for d in devices]

    for ident in targets:
        positions, perr = get_led_positions(sdk, ident)
        if perr != CorsairError.CE_Success or positions is None:
            continue
        colors: List[CorsairLedColor] = []
        for lp in getattr(positions, 'led_positions', []) or []:
            lid = getattr(lp, 'led_id', None)
            if lid is not None:
                colors.append(CorsairLedColor(int(lid), int(r), int(g), int(b)))
        if not colors:
            continue
        err = set_colors_buffer(sdk, ident, colors)
        if err != CorsairError.CE_Success:
            continue
        _ = flush_colors(sdk)
    json_out({'ok': True})


def set_leds_cmd(device_identifier: str, leds_payload: List[Dict[str, int]]):
    sdk = connect_sdk()
    ident: Union[int, str] = int(device_identifier) if is_int_str(device_identifier) else device_identifier
    colors: List[CorsairLedColor] = []
    for item in leds_payload:
        colors.append(CorsairLedColor(int(item['led_id']), int(item['r']), int(item['g']), int(item['b'])))
    err = set_colors_buffer(sdk, ident, colors)
    if err != CorsairError.CE_Success:
        json_out({'error': 'Failed to set LED colors', 'code': str(err)}, 1)
    _ = flush_colors(sdk)
    json_out({'ok': True})


def main():
    argv = sys.argv[1:]
    if not argv:
        json_out({'error': 'Usage: list_devices | list_leds <deviceId|index> | set_color <r> <g> <b> [deviceId|index] | set_leds <deviceId|index> <jsonArray>'}, 1)

    cmd = argv[0]
    try:
        if cmd == 'list_devices':
            list_devices_cmd()
        elif cmd == 'list_leds' and len(argv) >= 2:
            list_leds_cmd(argv[1])
        elif cmd == 'set_color' and len(argv) in (4, 5):
            r, g, b = int(argv[1]), int(argv[2]), int(argv[3])
            device_identifier = argv[4] if len(argv) == 5 else None
            set_color_cmd(r, g, b, device_identifier)
        elif cmd == 'set_leds' and len(argv) >= 3:
            device_identifier = argv[1]
            payload = json.loads(argv[2]) if len(argv) >= 3 else json.loads(sys.stdin.read())
            set_leds_cmd(device_identifier, payload)
        else:
            json_out({'error': 'Bad arguments'}, 1)
    except Exception as e:
        json_out({'error': str(e)}, 1)


if __name__ == '__main__':
    main()