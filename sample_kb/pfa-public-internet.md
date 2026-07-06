Zone: PFA
System: Network
Type: How-to

# Public internet in the PFA

The PFA (the venue foyer) has house network points on the skirting rail and floor boxes. By default these are on the production VLAN with no internet access.

## Getting a public internet feed

1. Identify the floor box or wall plate number you want to use (labelled **PFA-xx**).
2. In the comms room, find the corresponding port on the PFA patch panel.
3. Patch it to one of the ports on the switch labelled **PUBLIC** — these are on the guest/internet VLAN and hand out DHCP automatically.
4. Test with a laptop before handing over to the client: you should get an address and reach the internet without a captive portal.

## Wi-Fi option

For client Wi-Fi in the PFA, use the event SSID broadcast from the house APs. Ask the venue IT contact to enable the event SSID with the client's name — allow 24 hours notice for bump-in day.

## Rules

- Never patch production gear (consoles, switchers, comms) into PUBLIC ports.
- Client devices never go on the production VLAN. If a client needs a wired feed for a presentation laptop at the lectern, run a dedicated line back to a PUBLIC port instead of borrowing a production line.
