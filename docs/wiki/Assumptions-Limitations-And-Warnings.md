# Assumptions, Limitations, and Warnings

Overall, models can be useful in biological systems. But modelling must be undertaken with caution.

In general, it is important to be aware of the following:
- Models have assumptions which are not reflective of the real world. For example, our app disregards colour in light resistance calculations and uses simple raycasting. This is a simplification. Lights with different emission spectra will deter animals such as bats in different ways. Lights will scatter and reflect.
- Models should not be used as the deciding factor in decision making, but should be integrated into a larger body of evidence and interpreted carefully. A model can be useful but it does not replace the need for empirical evidence. Data from animals such as bats is not as abundant as data in other fields.

The models used in this application are informed by evidence from:
- [Finch et al. (2020). Modelling the functional connectivity of landscapes for greater horseshoe bats Rhinolophus ferrumequinum at a local scale.
](https://link.springer.com/article/10.1007/s10980-019-00953-1)
- [Henley et al. (2024). A simple and fast method for estimating bat roost locations.](https://royalsocietypublishing.org/rsos/article/11/4/231999/92749/A-simple-and-fast-method-for-estimating-bat-roost)

In particular, the models make critical assumptions in our application:

- Motion is diffusive and can be modelled using Circuitscape. For most organisms, this is an approximation. 
- The resistance parameters set govern the organism's diffusive behaviour. By default, these are chosen from Finch et al. (2020). However, these parameters are a single point estimate and are unlikely to exactly reflect the true parameters. These parameters are likely to depend on 
the species under investigation. 
- In addition, our resistance maps only take into account a few factors, such as the presence
of lights, roads, rivers, and topology. They miss important variables such as prey density. 
- Our lighting model is simple raycasting from point lamps which accounts for opacity, occlusion, and intensity. It does not account for scattering, color temperature, scheduled dimming, reflection, light from buildings, traffic headlights, and so on.
- Our resolution is fundamentally limited by the input data. LIDAR data goes down to 1 metre per pixel, but this can still obscure details.
