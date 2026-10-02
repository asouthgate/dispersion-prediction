# Sessions

The RoostMapper app is login-free. However, a unique token is still used under the hood to separate user sessions. This means that state is not saved between sessions. While using the app, make sure to save any results immediately before closing or refreshing the tab.

## Data

Raw input data, including roost coordinates, street lamp positions,
drawn polygons, and any vector features, is processed entirely in
your browser and is not transmitted to our servers. Only derived
model outputs (resistance and current rasters) are sent to the
server and are deleted after processing.
