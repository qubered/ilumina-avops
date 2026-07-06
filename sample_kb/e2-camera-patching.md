Zone: Main Room, Control Room
System: Video
Type: How-to

# Patching a camera into the E2

The Barco Event Master E2 is the main vision switcher for the Main Room. All camera feeds arrive at the control room video rack as 3G-SDI.

## Physical patch

1. Run the camera's SDI line back to the video rack (tie lines 1–12 terminate on the patch bay labelled **CAM TIE**).
2. Patch the tie line into a free E2 SDI input card port. Inputs 1–8 are reserved for cameras; 9–16 are for graphics and playback.
3. Note the input number — you need it for the layer mapping in the E2 UI.

## E2 configuration

1. Open **Event Master Toolset** on the control room PC (it auto-discovers the frame on the video VLAN).
2. In the **Configuration** tab, select the input you patched and set the correct format (cameras normally send 1080p50).
3. Drag the input onto a free layer in the **Programming** tab.
4. Verify the source appears in the multiviewer before taking it to program.

## Troubleshooting

- **No signal on the input card**: check the camera's SDI out and the tie line patch first; the input LED on the card should be green.
- **Wrong format detected**: force the format on the input rather than trusting auto-detect, then re-check the multiviewer.
- If the Toolset cannot find the frame, confirm the PC is on the video VLAN and not on venue Wi-Fi.
