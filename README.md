# OCPP EV Charger Controller

Control any EV Charger through its OCPP interface. Homey acts as a Central System that connects to OCPP-compatible charging stations.

## Features

- **Multi-Protocol Support**: OCPP 1.6-J and OCPP 2.0.1
- **Remote Control**: Start/stop charging sessions remotely
- **Real-time Status**: Monitor charger status and charging progress
- **Authentication**: Optional HTTP Basic Authentication support
- **Flow Cards**: Integrate charging stations into Homey automations

## Supported Protocols

Automatically detects and supports both **OCPP 1.6-J** and **OCPP 2.0.1** protocols.

### Connection URL
Connect using: `ws://[HOMEY-IP]:9000/[CHARGER-ID]`

The protocol version (1.6 or 2.0.1) is automatically detected based on the messages sent by your charger.

## Setup

1. Install the app on your Homey Pro
2. Configure OCPP server settings (port, authentication)
3. Configure your charger to connect to Homey's OCPP server
4. Add the charger as a device through the pairing process

## Configuration

### Charger Configuration
Configure your EV charger to connect to:
- **Server URL**: `ws://[HOMEY-IP]:9000/[CHARGER-ID]`
- **Protocol**: Automatically detected (supports OCPP 1.6-J and 2.0.1)
- **Charger ID**: Unique identifier for your charger

### Authentication (Optional)
If enabled in app settings:
- **Username**: As configured in app settings
- **Password**: As configured in app settings
- **Method**: HTTP Basic Authentication

## Capabilities

- **Connected**: Shows if charger is connected to OCPP server
- **Protocol Version**: Displays OCPP version used by charger
- **Charging Status**: Current status (Available, Charging, Faulted, etc.)

## Flow Cards

### Actions
- Start Charging: Initiate a charging session
- Stop Charging: End the current charging session  
- Set Availability: Enable/disable the charger

### Triggers
- Charger Connected: When charger connects to server
- Charger Disconnected: When charger disconnects
- Charging Started: When a charging session begins
- Charging Stopped: When a charging session ends

## Compatibility

This app works with any OCPP 1.6-J or OCPP 2.0.1 compatible charging station. Popular brands include:
- ABB
- Alfen 
- Easee 
- EVBox
- Wallbox
- Zaptec
- And many others supporting OCPP standards
