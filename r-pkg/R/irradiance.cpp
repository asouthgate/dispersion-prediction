#include <Rcpp.h>
#include <cmath>
#include <algorithm>
#include <vector>

using namespace Rcpp;

static const float LOG10 = 2.302585092994046f;

struct Lamp {
    int ri, cj;
    float z;
};

void cal_irradiance_raycast(double* irr, int m, int n,
                             int ri_lamp, int cj_lamp, double z,
                             const double* soft_surf, const double* hard_surf, const double* terrain,
                             double absorbance, double pixw, int cutoff, double sensor_ht) {

    if (ri_lamp < 0 || ri_lamp >= m || cj_lamp < 0 || cj_lamp >= n) return;

    int px_cutoff = (int)std::ceil(cutoff / pixw);
    int minj = std::max(cj_lamp - px_cutoff, 0);
    int maxj = std::min(n, cj_lamp + px_cutoff);
    int mini = std::max(ri_lamp - px_cutoff, 0);
    int maxi = std::min(m, ri_lamp + px_cutoff);

    float lamp_elev = terrain[ri_lamp * n + cj_lamp] + z;

    for (int cj = minj; cj < maxj; ++cj) {
        float pxdist_base = (float)(cj_lamp - cj);
        float pxdist2 = pxdist_base * pxdist_base;
        float xydist_base = pxdist_base * pixw;

        for (int ri = mini; ri < maxi; ++ri) {

            float pydist_base = (float)(ri_lamp - ri);
            float pxydist = std::sqrt(pxdist2 + pydist_base * pydist_base);
            int pdist = (int)std::floor(pxydist + 0.5f);

            float zdist = lamp_elev - (terrain[ri * n + cj] + sensor_ht);
            float xydist = pxydist * pixw;
            float xyzdist2 = xydist * xydist + zdist * zdist;

            if (xydist >= cutoff || zdist <= 0 || pdist <= 0) continue;

            float shadow = 1.0f;
            float shading = 0.0f;

            float step_i = pydist_base / (float)pdist;
            float step_j = pxdist_base / (float)pdist;
            float step_h = zdist / (float)pdist;
            float cell_elev = terrain[ri * n + cj] + sensor_ht;

            for (int d = 1; d <= pdist; ++d) {
                float frac = (float)d;
                int dii = (int)std::round((float)ri + step_i * frac);
                int djj = (int)std::round((float)cj + step_j * frac);
                float hiijj = cell_elev + step_h * frac;

                if (hard_surf[dii * n + djj] + terrain[dii * n + djj] >= hiijj) {
                    shadow = 0.0f;
                    break;
                }
                if (soft_surf[dii * n + djj] + terrain[dii * n + djj] >= hiijj) {
                    shading += pixw * std::sqrt(xyzdist2) / xydist;
                }
            }

            float invd = 1.0f / xyzdist2;
            float occ = 1.0f / std::exp(absorbance * shading * LOG10);
            irr[ri * n + cj] += occ * shadow * invd;
        }
    }
}

// [[Rcpp::export]]
NumericMatrix cal_irradiance(NumericMatrix lights,
                                    NumericMatrix soft_surf, NumericMatrix hard_surf, NumericMatrix terrain,
                                    int xmin, int xmax, int ymin, int ymax,
                                    float absorb, float pix, int cutoff, float sensor_ht) {

    int m = soft_surf.nrow();
    int n = soft_surf.ncol();
    NumericMatrix irradiance(m, n);

    int nlamps = lights.nrow();
    if (nlamps == 0) return irradiance;

    float xrange = (float)(xmax - xmin);
    float yrange = (float)(ymax - ymin);
    float xscale = (float)(n - 1) / xrange;
    float yscale = (float)(m - 1) / yrange;

    std::vector<Lamp> lamps;
    lamps.reserve(nlamps);
    for (int i = 0; i < nlamps; ++i) {
        float x = lights(i, 0);
        float y = lights(i, 1);
        float z = lights(i, 2);
        int ri = (int)std::round((ymax - y) * yscale);
        int cj = (int)std::round((x - xmin) * xscale);
        if (ri >= 0 && ri < m && cj >= 0 && cj < n) {
            lamps.push_back({ri, cj, z});
        }
    }

    // sort by row then column for cache-friendly access to terrain/surface data
    std::sort(lamps.begin(), lamps.end(),
        [](const Lamp& a, const Lamp& b) {
            if (a.ri != b.ri) return a.ri < b.ri;
            return a.cj < b.cj;
        });

    double* irr = irradiance.begin();
    const double* soft = soft_surf.begin();
    const double* hard = hard_surf.begin();
    const double* terr = terrain.begin();

    for (const auto& lamp : lamps) {
        cal_irradiance_raycast(irr, m, n, lamp.ri, lamp.cj, lamp.z,
                               soft, hard, terr, absorb, pix, cutoff, sensor_ht);
    }

    return irradiance;
}
