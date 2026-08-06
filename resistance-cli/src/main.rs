use std::env;
use std::fs;
use std::io::{self, BufReader, BufWriter};
use std::path::{Path, PathBuf};
use tiff::decoder::{Decoder, DecodingResult};
use tiff::encoder::{colortype, TiffEncoder};
use wasm_connect::resistance::pipeline::{run_resistance_pipeline, ResistanceParams};

fn read_tiff_f32(path: &Path) -> io::Result<(Vec<f64>, usize, usize)> {
    let file = fs::File::open(path)?;
    let mut decoder = Decoder::new(BufReader::new(file))
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

    let (width, height) = decoder
        .dimensions()
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
    let ncols = width as usize;
    let nrows = height as usize;

    match decoder
        .read_image()
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?
    {
        DecodingResult::F32(data) => {
            let data_f64: Vec<f64> = data.into_iter().map(|v| v as f64).collect();
            Ok((data_f64, nrows, ncols))
        }
        DecodingResult::F64(data) => Ok((data, nrows, ncols)),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "expected float32 or float64 TIFF",
        )),
    }
}

fn write_tiff_f32(path: &Path, data: &[f64], ncols: usize, nrows: usize) -> io::Result<()> {
    let file = fs::File::create(path)?;
    let mut tiff = TiffEncoder::new(BufWriter::new(file))
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

    let data_f32: Vec<f32> = data.iter().map(|&v| v as f32).collect();

    tiff.write_image::<colortype::Gray32Float>(ncols as u32, nrows as u32, &data_f32)
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

    Ok(())
}

fn write_asc(path: &Path, data: &[f64], ncols: usize, nrows: usize, xmin: f64, ymin: f64, cellsize: f64, nodata: f64) -> io::Result<()> {
    use std::io::Write;
    let file = fs::File::create(path)?;
    let mut w = BufWriter::new(file);

    writeln!(w, "ncols         {}", ncols)?;
    writeln!(w, "nrows         {}", nrows)?;
    writeln!(w, "xllcorner     {}", xmin)?;
    writeln!(w, "yllcorner     {}", ymin)?;
    writeln!(w, "cellsize      {}", cellsize)?;
    writeln!(w, "NODATA_value  {}", nodata)?;

    for r in 0..nrows {
        let row_start = r * ncols;
        for c in 0..ncols {
            let v = data[row_start + c];
            if c > 0 { write!(w, " ")?; }
            if v.is_finite() {
                write!(w, "{}", v)?;
            } else {
                write!(w, "{}", nodata)?;
            }
        }
        writeln!(w)?;
    }

    Ok(())
}

fn read_json(path: &Path) -> io::Result<serde_json::Value> {
    let content = fs::read_to_string(path)?;
    serde_json::from_str(&content)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))
}

fn read_optional_tiff(work_dir: &Path, name: &str) -> io::Result<Option<(Vec<f64>, usize, usize)>> {
    let path = work_dir.join(name);
    if path.exists() {
        let (data, nrows, ncols) = read_tiff_f32(&path)?;
        Ok(Some((data, nrows, ncols)))
    } else {
        Ok(None)
    }
}

fn emit_json_log(level: &str, message: &str) {
    let log = serde_json::json!({
        "level": level,
        "message": message,
        "user_visible": true
    });
    println!("{}", serde_json::to_string(&log).unwrap_or_default());
}

fn create_circles_raster(
    nrows: usize,
    ncols: usize,
    roost_row: usize,
    roost_col: usize,
    radius_meters: f64,
    pixw: f64,
    n_circles: usize,
) -> Vec<f64> {
    let total = nrows * ncols;
    let mut circles = vec![0.0f64; total];
    let radius_cells = radius_meters / pixw;
    let lb = (radius_cells / n_circles as f64).max(1.0);

    let mut r = lb;
    while r <= radius_cells {
        let n_pts = (3.0 * r).max(10.0) as usize;
        for i in 0..n_pts {
            let angle = 2.0 * std::f64::consts::PI * i as f64 / n_pts as f64;
            let col = roost_col as f64 + r * angle.sin();
            let row = roost_row as f64 + r * angle.cos();
            if col >= 0.0 && col < ncols as f64 && row >= 0.0 && row < nrows as f64 {
                let idx = row as usize * ncols + col as usize;
                circles[idx] = 1.0;
            }
        }
        r += lb;
    }

    circles
}

fn main() -> io::Result<()> {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: resistance-pipeline <work_dir>");
        std::process::exit(1);
    }

    let work_dir = PathBuf::from(&args[1]);
    let input_path = work_dir.join("inputs.json");

    emit_json_log("INFO", "Resistance pipeline starting");

    let input = read_json(&input_path)?;
    let empty_map = serde_json::Map::new();
    let params_json = input
        .get("params")
        .and_then(serde_json::Value::as_object)
        .unwrap_or(&empty_map);

    let roost = input.get("roost").and_then(|r| r.as_object());
    let resolution = params_json
        .get("resolution")
        .and_then(|v| v.as_f64())
        .unwrap_or(10.0);
    let radius = roost
        .and_then(|r| r.get("radius"))
        .and_then(|v| v.as_f64())
        .unwrap_or(2500.0);
    let n_circles = params_json
        .get("n_circles")
        .and_then(|v| v.as_f64())
        .map(|v| v as usize)
        .unwrap_or(5);
    let roost_easting = roost.and_then(|r| r.get("easting")).and_then(|v| v.as_f64());
    let roost_northing = roost.and_then(|r| r.get("northing")).and_then(|v| v.as_f64());

    let xmin = roost_easting.unwrap_or(0.0) - radius;
    let ymin = roost_northing.unwrap_or(0.0) - radius;

    emit_json_log("INFO", &format!(
        "Reading raster inputs (resolution={}, radius={})",
        resolution, radius
    ));

    let required = ["dtm", "dsm", "lcm"];
    for name in &required {
        let path = work_dir.join(format!("{}.tif", name));
        if !path.exists() {
            emit_json_log("ERROR", &format!("Missing required raster: {}.tif", name));
            std::process::exit(1);
        }
    }

    let (dtm, nrows_dtm, ncols_dtm) = read_tiff_f32(&work_dir.join("dtm.tif"))?;
    let (dsm, nrows_dsm, _ncols_dsm) = read_tiff_f32(&work_dir.join("dsm.tif"))?;
    let (lcm, _, _) = read_tiff_f32(&work_dir.join("lcm.tif"))?;

    assert_eq!(nrows_dtm, nrows_dsm, "DTM and DSM dimensions must match");
    let nrows = nrows_dtm;
    let ncols = ncols_dtm;

    let road_binary = read_optional_tiff(&work_dir, "road_binary.tif")?
        .map(|(d, _, _)| d)
        .unwrap_or_else(|| vec![0.0; nrows * ncols]);

    let river_binary = read_optional_tiff(&work_dir, "river_binary.tif")?
        .map(|(d, _, _)| d)
        .unwrap_or_else(|| vec![0.0; nrows * ncols]);

    let building_mask = read_optional_tiff(&work_dir, "buildings.tif")?
        .map(|(d, _, _)| d)
        .unwrap_or_else(|| vec![0.0; nrows * ncols]);

    let generic_res = read_optional_tiff(&work_dir, "generic_resistance.tif")?
        .map(|(d, _, _)| d)
        .unwrap_or_else(|| vec![0.0; nrows * ncols]);

    let lamps: Vec<f64> = input
        .get("lamps")
        .and_then(|l| l.as_array())
        .map(|arr| {
            arr.iter()
                .flat_map(|v| {
                    if let Some(arr2) = v.as_array() {
                        arr2.iter()
                            .filter_map(|n| n.as_f64())
                            .collect::<Vec<_>>()
                    } else if let Some(n) = v.as_f64() {
                        vec![n]
                    } else {
                        vec![]
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    let n_pixels = nrows * ncols;
    emit_json_log("INFO", &format!(
        "Processing {}x{} grid ({} pixels), {} lamp(s)",
        nrows, ncols, n_pixels, lamps.len() / 3.max(1)
    ));

    let pixw = resolution;
    let params = ResistanceParams {
        road_buffer: params_json.get("road_buffer").and_then(|v| v.as_f64()).unwrap_or(200.0),
        road_resmax: params_json.get("road_resmax").and_then(|v| v.as_f64()).unwrap_or(10.0),
        road_xmax: params_json.get("road_xmax").and_then(|v| v.as_f64()).unwrap_or(5.0),
        river_buffer: params_json.get("river_buffer").and_then(|v| v.as_f64()).unwrap_or(10.0),
        river_resmax: params_json.get("river_resmax").and_then(|v| v.as_f64()).unwrap_or(2000.0),
        river_xmax: params_json.get("river_xmax").and_then(|v| v.as_f64()).unwrap_or(4.0),
        landscape_rankmax: params_json.get("landscape_rankmax").and_then(|v| v.as_f64()).unwrap_or(8.0),
        landscape_resmax: params_json.get("landscape_resmax").and_then(|v| v.as_f64()).unwrap_or(100.0),
        landscape_xmax: params_json.get("landscape_xmax").and_then(|v| v.as_f64()).unwrap_or(5.0),
        linear_buffer: params_json.get("linear_buffer").and_then(|v| v.as_f64()).unwrap_or(10.0),
        linear_rankmax: params_json.get("linear_rankmax").and_then(|v| v.as_f64()).unwrap_or(4.0),
        linear_resmax: params_json.get("linear_resmax").and_then(|v| v.as_f64()).unwrap_or(22000.0),
        linear_xmax: params_json.get("linear_xmax").and_then(|v| v.as_f64()).unwrap_or(3.0),
        lamp_resmax: params_json.get("lamp_resmax").and_then(|v| v.as_f64()).unwrap_or(1e8),
        lamp_xmax: params_json.get("lamp_xmax").and_then(|v| v.as_f64()).unwrap_or(1.0),
        lamp_ext: params_json.get("lamp_ext").and_then(|v| v.as_f64()).unwrap_or(100.0),
        pixw,
        nrows,
        ncols,
    };

    emit_json_log("INFO", "Computing resistance rasters");
    let output = run_resistance_pipeline(
        &road_binary,
        &river_binary,
        &building_mask,
        &lcm,
        &dtm,
        &dsm,
        &generic_res,
        &lamps,
        &params,
    );

    emit_json_log("INFO", "Writing output GeoTIFFs and ASC files");

    let write_layer = |name: &str, data: &[f64]| {
        let path = work_dir.join(format!("{}.tif", name));
        write_tiff_f32(&path, data, ncols, nrows)
            .unwrap_or_else(|e| eprintln!("Failed to write {}: {}", name, e));
    };

    write_layer("road_res", &output.road_res);
    write_layer("river_res", &output.river_res);
    write_layer("landscape_res", &output.landscape_res);
    write_layer("linear_res", &output.linear_res);
    write_layer("lamp_res", &output.lamp_res);
    write_layer("generic_res", &output.generic_res);
    write_layer("total_res", &output.total_res);
    write_layer("soft_surf", &output.soft_surf);
    write_layer("hard_surf", &output.hard_surf);
    write_layer("manhedge", &output.manhedge);
    write_layer("unmanhedge", &output.unmanhedge);
    write_layer("tree", &output.tree);

    let log_total_res: Vec<f64> = output.total_res.iter().map(|&v| if v.is_finite() && v > 0.0 { v.ln() } else { f64::NAN }).collect();
    write_layer("log_total_res", &log_total_res);

    if output.lamp_res.iter().any(|&v| v > 0.0) {
        let log_lamp_res: Vec<f64> = output.lamp_res.iter().map(|&v| if v.is_finite() && v > 0.0 { v.ln() } else { f64::NAN }).collect();
        write_layer("log_lamp_res", &log_lamp_res);
    }

    let circuitscape_dir = work_dir.join("circuitscape");
    fs::create_dir_all(&circuitscape_dir).ok();

    write_asc(
        &circuitscape_dir.join("resistance.asc"),
        &output.total_res, ncols, nrows, xmin, ymin, pixw, -9999.0,
    )?;

    let roost_col = if let (Some(e), Some(_n)) = (roost_easting, roost_northing) {
        ((e - xmin) / pixw) as usize
    } else {
        ncols / 2
    };
    let roost_row = if let (Some(_e), Some(n)) = (roost_easting, roost_northing) {
        ((ymin + nrows as f64 * pixw - n) / pixw) as usize
    } else {
        nrows / 2
    };

    let circles = create_circles_raster(nrows, ncols, roost_row, roost_col, radius, pixw, n_circles);
    write_asc(
        &circuitscape_dir.join("source.asc"),
        &circles, ncols, nrows, xmin, ymin, pixw, -9999.0,
    )?;

    let mut ground = vec![0.0f64; nrows * ncols];
    if roost_row < nrows && roost_col < ncols {
        ground[roost_row * ncols + roost_col] = 1.0;
    }
    write_asc(
        &circuitscape_dir.join("ground.asc"),
        &ground, ncols, nrows, xmin, ymin, pixw, -9999.0,
    )?;

    emit_json_log("INFO", "Resistance pipeline complete");

    Ok(())
}
